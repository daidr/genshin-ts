import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import type {
  GiaWriteFileProfile,
  GiaWriteResult,
  WriteGiaFromIrJsonFileOptions
} from './ir_to_gia_transform/shared.js'

export { writeGiaFromIrJsonFile } from './ir_to_gia_transform/shared.js'
export type {
  GiaWriteFileProfile,
  GiaWriteResult,
  WriteGiaFromIrJsonFileOptions
} from './ir_to_gia_transform/shared.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runnerPath = path.join(__dirname, 'ir_to_gia_transform', 'runner.js')
const runnerMode = fs.existsSync(runnerPath) ? 'node' : 'tsx'

export function resolveGiaOutputPath(irJsonPath: string): string {
  return irJsonPath.replace(/\.json$/i, '.gia')
}

export type IrToGiaParallelOptions = {
  maxParallel?: number
  cwd?: string
  profile?: boolean
  onProfile?: (profile: IrToGiaBatchProfile) => void
  /**
   * Called when runner emits an `[ok] ...` progress line.
   * The argument is the message part after `[ok] ` (e.g. `path (id=123)`).
   */
  onOkLine?: (msg: string) => void
}

export type IrToGiaTaskProfile = {
  irPath: string
  wallMs: number
  startupOverheadMs?: number
  schedule?: {
    originalIndex: number
    workerSlot: number
    estimatedCostBytes: number
    queuedAtMs: number
    startedAtMs: number
    finishedAtMs: number
    queueWaitMs: number
  }
  child?: GiaWriteFileProfile
}

export type IrToGiaBatchProfile = {
  stats: {
    tasks: number
    maxParallel: number
    workerProcesses?: number
    runner: 'node' | 'tsx'
    sumTaskWallMs: number
    sumChildMs: number
    sumStartupOverheadMs: number
  }
  timingsMs: {
    wall: number
  }
  tasks: IrToGiaTaskProfile[]
}

type GiaTask = { irPath: string; outFile?: string; opts?: WriteGiaFromIrJsonFileOptions }

type RunnerSchedule = {
  batchStart: number
  originalIndex: number
  workerSlot: number
  estimatedCostBytes: number
}

type WorkerResponse = {
  id: number
  outputs?: GiaWriteResult[]
  profile?: GiaWriteFileProfile
  error?: string
}

type PendingWorkerTask = {
  id: number
  absIr: string
  wallStart: number
  startedAtMs: number
  schedule?: RunnerSchedule
  resolve: (result: { outputs: GiaWriteResult[]; profile?: IrToGiaTaskProfile }) => void
  reject: (error: unknown) => void
}

function createRunnerWorker(opts: Pick<IrToGiaParallelOptions, 'cwd' | 'onOkLine' | 'profile'>) {
  const runnerArgs = [runnerPath, '--worker']
  const args = runnerMode === 'node' ? runnerArgs : [require.resolve('tsx/cli'), ...runnerArgs]
  const child = spawn(process.execPath, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  })
  let nextId = 1
  let stdoutBuf = ''
  let stderrBuf = ''
  let pending: PendingWorkerTask | undefined
  let fatalError: unknown
  let exited = false
  let resolveExit: (() => void) | undefined
  const exitPromise = new Promise<void>((resolve) => (resolveExit = resolve))

  const failPending = (error: unknown) => {
    const current = pending
    pending = undefined
    current?.reject(error)
  }
  const consumeStderrLine = (line: string) => {
    const okMatch = /^\[ok\]\s+(.*)$/.exec(line)
    if (okMatch) opts.onOkLine?.(okMatch[1] ?? '')
    else if (line.length) process.stderr.write(`${line}\n`)
  }
  const consumeStdoutLine = (line: string) => {
    const current = pending
    if (!current) return
    let response: WorkerResponse
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      response = parsed as WorkerResponse
      if (response.id !== current.id) throw new Error()
    } catch {
      fatalError = new Error(`[error] ir_to_gia runner invalid output: ${current.absIr}`)
      failPending(fatalError)
      return
    }

    pending = undefined
    if (response.error || !Array.isArray(response.outputs)) {
      current.reject(new Error(`[error] ir_to_gia failed: ${current.absIr}`))
      return
    }
    if (!opts.profile) {
      current.resolve({ outputs: response.outputs })
      return
    }

    const wallMs = performance.now() - current.wallStart
    const finishedAtMs = current.schedule ? performance.now() - current.schedule.batchStart : 0
    current.resolve({
      outputs: response.outputs,
      profile: {
        irPath: current.absIr,
        wallMs,
        ...(current.schedule
          ? {
              schedule: {
                originalIndex: current.schedule.originalIndex,
                workerSlot: current.schedule.workerSlot,
                estimatedCostBytes: current.schedule.estimatedCostBytes,
                queuedAtMs: 0,
                startedAtMs: current.startedAtMs,
                finishedAtMs,
                queueWaitMs: current.startedAtMs
              }
            }
          : {}),
        ...(response.profile
          ? {
              child: response.profile,
              startupOverheadMs: Math.max(0, wallMs - response.profile.timingsMs.total)
            }
          : {})
      }
    })
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk
    while (true) {
      const index = stdoutBuf.indexOf('\n')
      if (index < 0) break
      const line = stdoutBuf.slice(0, index).replace(/\r$/, '')
      stdoutBuf = stdoutBuf.slice(index + 1)
      if (line.length) consumeStdoutLine(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk
    while (true) {
      const index = stderrBuf.indexOf('\n')
      if (index < 0) break
      const line = stderrBuf.slice(0, index).replace(/\r$/, '')
      stderrBuf = stderrBuf.slice(index + 1)
      consumeStderrLine(line)
    }
  })
  child.stdin.on('error', (error) => {
    fatalError = error
    failPending(error)
  })
  child.on('error', (error) => {
    fatalError = error
    failPending(error)
  })
  child.on('close', (code) => {
    exited = true
    if (stderrBuf.length) consumeStderrLine(stderrBuf.replace(/\r$/, ''))
    if (pending) {
      failPending(new Error(`[error] ir_to_gia failed: ${pending.absIr}`))
    }
    if (code !== 0 && fatalError === undefined) {
      fatalError = new Error(`[error] ir_to_gia worker exited with code ${String(code)}`)
    }
    resolveExit?.()
  })

  return {
    run(
      task: GiaTask,
      schedule?: RunnerSchedule
    ): Promise<{ outputs: GiaWriteResult[]; profile?: IrToGiaTaskProfile }> {
      if (pending) return Promise.reject(new Error('[error] ir_to_gia worker is busy'))
      if (fatalError !== undefined) return Promise.reject(fatalError)
      if (exited) return Promise.reject(new Error('[error] ir_to_gia worker exited'))

      const absIr = path.resolve(task.irPath)
      const wallStart = opts.profile ? performance.now() : 0
      const startedAtMs = opts.profile && schedule ? wallStart - schedule.batchStart : 0
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending = { id, absIr, wallStart, startedAtMs, schedule, resolve, reject }
        child.stdin.write(
          `${JSON.stringify({
            id,
            irPath: absIr,
            outFile: task.outFile ? path.resolve(task.outFile) : undefined,
            opts: task.opts,
            profile: !!opts.profile
          })}\n`,
          (error) => {
            if (error && pending?.id === id) failPending(error)
          }
        )
      })
    },
    async close() {
      if (!exited) child.stdin.end()
      await exitPromise
    }
  }
}

async function runWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number, workerSlot: number) => Promise<R>,
  onWorkerDone?: (workerSlot: number) => Promise<void>
): Promise<R[]> {
  let nextIndex = 0
  let firstError: unknown
  let hasError = false
  const slots = Math.min(limit, items.length)
  const results: R[] = []
  const runners = Array.from({ length: slots }, async (_, workerSlot) => {
    try {
      while (true) {
        // Drain tasks already in flight, but never dispatch another after the first failure.
        if (hasError || nextIndex >= items.length) break
        const i = nextIndex++
        const item = items[i]
        try {
          results[i] = await worker(item, i, workerSlot)
        } catch (error) {
          if (!hasError) {
            hasError = true
            firstError = error
          }
        }
      }
    } finally {
      await onWorkerDone?.(workerSlot)
    }
  })
  await Promise.all(runners)
  if (hasError) throw firstError
  return results
}

export async function writeGiaFromIrJsonFiles(
  tasks: GiaTask[],
  opts: IrToGiaParallelOptions = {}
): Promise<GiaWriteResult[]> {
  if (!tasks.length) return []
  const maxParallel = Math.max(1, opts.maxParallel ?? Math.max(1, os.cpus().length - 1))
  const wallStart = opts.profile ? performance.now() : 0
  const scheduled = tasks
    .map((task, originalIndex) => {
      let estimatedCostBytes = 0
      try {
        estimatedCostBytes = fs.statSync(task.irPath).size
      } catch {
        // Let the runner preserve the existing file error behavior.
      }
      return { task, originalIndex, estimatedCostBytes }
    })
    .sort(
      (a, b) => b.estimatedCostBytes - a.estimatedCostBytes || a.originalIndex - b.originalIndex
    )
  const workerCount = Math.min(maxParallel, scheduled.length)
  const workers: Array<ReturnType<typeof createRunnerWorker> | undefined> = new Array(workerCount)
  const scheduledResults = await runWithLimit(
    scheduled,
    workerCount,
    async (item, _scheduleIndex, workerSlot) => {
      // Start the largest tasks as soon as their slots begin. Creating every child process up
      // front delays the first dispatch while Node synchronously spawns the remaining workers.
      const worker = workers[workerSlot] ?? createRunnerWorker(opts)
      workers[workerSlot] = worker
      return await worker.run(
        item.task,
        opts.profile
          ? {
              batchStart: wallStart,
              originalIndex: item.originalIndex,
              workerSlot,
              estimatedCostBytes: item.estimatedCostBytes
            }
          : undefined
      )
    },
    async (workerSlot) => {
      await workers[workerSlot]?.close()
    }
  )
  const perTask: typeof scheduledResults = []
  scheduled.forEach((item, index) => {
    perTask[item.originalIndex] = scheduledResults[index]
  })
  if (opts.profile) {
    const profiles = perTask
      .map((item) => item.profile)
      .filter((item): item is IrToGiaTaskProfile => !!item)
    const sumTaskWallMs = profiles.reduce((sum, item) => sum + item.wallMs, 0)
    const sumChildMs = profiles.reduce((sum, item) => sum + (item.child?.timingsMs.total ?? 0), 0)
    const sumStartupOverheadMs = profiles.reduce(
      (sum, item) => sum + (item.startupOverheadMs ?? 0),
      0
    )
    opts.onProfile?.({
      stats: {
        tasks: profiles.length,
        maxParallel,
        workerProcesses: workerCount,
        runner: runnerMode,
        sumTaskWallMs,
        sumChildMs,
        sumStartupOverheadMs
      },
      timingsMs: {
        wall: performance.now() - wallStart
      },
      tasks: profiles
    })
  }
  return perTask.flatMap((item) => item.outputs)
}
