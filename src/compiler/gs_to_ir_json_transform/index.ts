import { fork, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import {
  compileGsModulesToJs,
  resolveGsJsOutputPath,
  type GsToJsCompileProfile
} from '../gs_to_js_pipeline.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runnerJsPath = path.join(__dirname, 'runner.js')
const runnerPath = fs.existsSync(runnerJsPath) ? runnerJsPath : path.join(__dirname, 'runner.ts')
const batchRunnerJsPath = path.join(__dirname, 'batch_runner.js')

export type GsToJsonOptions = {
  maxParallel?: number
  compact?: boolean
  cwd?: string
  /** Resolved CLI language passed to isolated runners to avoid per-process OS locale detection. */
  lang?: 'zh-CN' | 'en-US'
  /** All generated .gs.ts runtime modules. When present they are compiled once and entries run with Node. */
  moduleFiles?: string[]
  /** Output root shared by moduleFiles. Required when moduleFiles is present. */
  moduleRoot?: string
  profile?: boolean
  onProfile?: (profile: GsToIrBatchProfile) => void
  runtimeOptions?: {
    precompileExpression?: boolean
    removeUnusedNodes?: boolean
  }
}

export type GsToIrChildProfile = {
  stats: {
    inputBytes: number
    outputBytes: number
    documents: number
    nodes: number
    variables: number
  }
  timingsMs: {
    importEntry: number
    buildDocuments: number
    stringify: number
    write: number
    total: number
  }
}

export type GsToIrTaskProfile = {
  entry: string
  runtimeEntry: string
  outFile: string
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
  child?: GsToIrChildProfile
}

export type GsToIrBatchProfile = {
  stats: {
    tasks: number
    modules: number
    runner: 'worker' | 'node' | 'tsx'
    maxParallel: number
    sumTaskWallMs: number
    sumChildMs: number
    sumStartupOverheadMs: number
  }
  timingsMs: {
    precompile: number
    execute: number
    wall: number
  }
  precompile?: GsToJsCompileProfile
  tasks: GsToIrTaskProfile[]
}

const PROFILE_PREFIX = '[gsts-profile:gs-to-ir] '

type RunnerSchedule = {
  batchStart: number
  originalIndex: number
  workerSlot: number
  estimatedCostBytes: number
}

type WorkerRunnerMessage = {
  kind: 'gsts-gs-to-ir-result'
  profile?: GsToIrChildProfile
}

export type PreparedGsToIrEntry = {
  entry: string
  runtimeEntry: string
  outFile: string
}

export type GsWorkerBatchRequest = {
  kind: 'gsts-gs-worker-batch'
  entries: PreparedGsToIrEntry[]
  maxParallel: number
  compact: boolean
  profile: boolean
}

export type GsWorkerBatchResponse = {
  kind: 'gsts-gs-worker-batch-result'
  profiles?: Array<GsToIrTaskProfile | undefined>
  error?: {
    name: string
    message: string
    stack?: string
    code?: string | number
  }
}

function getFileExecArgv(): string[] {
  const args: string[] = []
  for (let i = 0; i < process.execArgv.length; i += 1) {
    const arg = process.execArgv[i]
    if (arg === '--eval' || arg === '-e' || arg === '--print' || arg === '-p') {
      i += 1
      continue
    }
    if (arg === '--input-type') {
      i += 1
      continue
    }
    if (
      arg.startsWith('--eval=') ||
      arg.startsWith('--print=') ||
      arg.startsWith('--input-type=') ||
      (arg.startsWith('-e') && !arg.startsWith('--')) ||
      (arg.startsWith('-p') && !arg.startsWith('--'))
    ) {
      continue
    }
    args.push(arg)
  }
  if (!args.includes('--enable-source-maps')) args.push('--enable-source-maps')
  return args
}

function getWorkerExecArgv(): string[] {
  const args = getFileExecArgv()
  const workerArgs: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--expose-gc') continue
    if (arg === '--max-old-space-size' || arg === '--max-semi-space-size') {
      i += 1
      continue
    }
    if (arg.startsWith('--max-old-space-size=') || arg.startsWith('--max-semi-space-size=')) {
      continue
    }
    workerArgs.push(arg)
  }
  return workerArgs
}

export function hasEntryMarker(text: string): boolean {
  const cleaned = text.replace(/^\uFEFF/, '')
  const firstLine = cleaned.split(/\r?\n/, 1)[0]
  return /^\s*\/\/\s*@gsts:entry\s*$/.test(firstLine)
}

export function resolveIrOutputPath(entryFile: string): string {
  return entryFile.replace(/\.gs\.ts$/i, '.json')
}

function spawnRunner(
  entryFile: string,
  runtimeEntry: string,
  outFile: string,
  compact: boolean,
  directNode: boolean,
  cwd?: string,
  runtimeOptions?: GsToJsonOptions['runtimeOptions'],
  profile?: boolean,
  lang?: GsToJsonOptions['lang'],
  schedule?: RunnerSchedule
): Promise<GsToIrTaskProfile | undefined> {
  return new Promise((resolve, reject) => {
    const wallStart = profile ? performance.now() : 0
    const startedAtMs = profile && schedule ? wallStart - schedule.batchStart : 0
    const args = directNode
      ? ['--enable-source-maps', runnerPath, runtimeEntry, outFile, compact ? '1' : '0']
      : [require.resolve('tsx/cli'), runnerPath, runtimeEntry, outFile, compact ? '1' : '0']
    const env = { ...process.env }
    if (runtimeOptions && runtimeOptions.precompileExpression !== undefined) {
      env.GSTS_PRECOMPILE_EXPR = runtimeOptions.precompileExpression ? '1' : '0'
    }
    if (runtimeOptions && runtimeOptions.removeUnusedNodes !== undefined) {
      env.GSTS_REMOVE_UNUSED_NODES = runtimeOptions.removeUnusedNodes ? '1' : '0'
    }
    if (lang) env.GSTS_RUNNER_LANG = lang
    if (profile) env.GSTS_PIPELINE_PROFILE = '1'
    const child = spawn(process.execPath, args, {
      stdio: profile ? ['inherit', 'inherit', 'pipe'] : 'inherit',
      cwd,
      env
    })
    let stderrBuf = ''
    let childProfile: GsToIrChildProfile | undefined
    const consumeStderrLine = (line: string) => {
      if (line.startsWith(PROFILE_PREFIX)) {
        try {
          const parsed = JSON.parse(line.slice(PROFILE_PREFIX.length)) as GsToIrChildProfile
          childProfile = parsed
        } catch {
          process.stderr.write(line + '\n')
        }
        return
      }
      if (line.length) process.stderr.write(line + '\n')
    }
    if (profile) {
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderrBuf += chunk
        while (true) {
          const idx = stderrBuf.indexOf('\n')
          if (idx < 0) break
          consumeStderrLine(stderrBuf.slice(0, idx).replace(/\r$/, ''))
          stderrBuf = stderrBuf.slice(idx + 1)
        }
      })
    }
    child.on('error', reject)
    child.on('exit', (code) => {
      if (profile && stderrBuf.length) consumeStderrLine(stderrBuf.replace(/\r$/, ''))
      if (code !== 0) {
        reject(new Error(`[error] gs_to_ir_json failed: ${entryFile}`))
        return
      }
      if (!profile) {
        resolve(undefined)
        return
      }
      const wallMs = performance.now() - wallStart
      const finishedAtMs = schedule ? performance.now() - schedule.batchStart : 0
      resolve({
        entry: entryFile,
        runtimeEntry,
        outFile,
        wallMs,
        ...(schedule
          ? {
              schedule: {
                originalIndex: schedule.originalIndex,
                workerSlot: schedule.workerSlot,
                estimatedCostBytes: schedule.estimatedCostBytes,
                queuedAtMs: 0,
                startedAtMs,
                finishedAtMs,
                queueWaitMs: startedAtMs
              }
            }
          : {}),
        ...(childProfile
          ? {
              child: childProfile,
              startupOverheadMs: Math.max(0, wallMs - childProfile.timingsMs.total)
            }
          : {})
      })
    })
  })
}

function runWorker(
  entryFile: string,
  runtimeEntry: string,
  outFile: string,
  compact: boolean,
  env: NodeJS.ProcessEnv,
  profile?: boolean,
  schedule?: RunnerSchedule
): Promise<GsToIrTaskProfile | undefined> {
  return new Promise((resolve, reject) => {
    const wallStart = profile ? performance.now() : 0
    const startedAtMs = profile && schedule ? wallStart - schedule.batchStart : 0
    const worker = new Worker(runnerJsPath, {
      workerData: {
        kind: 'gsts-gs-to-ir',
        entryFile: runtimeEntry,
        outFile,
        compact
      },
      env,
      execArgv: getWorkerExecArgv(),
      stderr: true
    })
    let settled = false
    let childProfile: GsToIrChildProfile | undefined
    worker.stderr.on('data', (chunk: Buffer | string) => process.stderr.write(chunk))
    worker.on('message', (message: WorkerRunnerMessage) => {
      if (message?.kind === 'gsts-gs-to-ir-result') childProfile = message.profile
    })
    worker.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    worker.on('exit', (code) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(new Error(`[error] gs_to_ir_json failed: ${entryFile}`))
        return
      }
      if (!profile) {
        resolve(undefined)
        return
      }
      const wallMs = performance.now() - wallStart
      const finishedAtMs = schedule ? performance.now() - schedule.batchStart : 0
      resolve({
        entry: entryFile,
        runtimeEntry,
        outFile,
        wallMs,
        ...(schedule
          ? {
              schedule: {
                originalIndex: schedule.originalIndex,
                workerSlot: schedule.workerSlot,
                estimatedCostBytes: schedule.estimatedCostBytes,
                queuedAtMs: 0,
                startedAtMs,
                finishedAtMs,
                queueWaitMs: startedAtMs
              }
            }
          : {}),
        ...(childProfile
          ? {
              child: childProfile,
              startupOverheadMs: Math.max(0, wallMs - childProfile.timingsMs.total)
            }
          : {})
      })
    })
  })
}

async function runWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number, workerSlot: number) => Promise<R>
) {
  let index = 0
  const slots = Math.min(limit, items.length)
  const results: R[] = []
  const runners = Array.from({ length: slots }, async (_, workerSlot) => {
    while (true) {
      if (index >= items.length) break
      const currentIndex = index++
      results[currentIndex] = await worker(items[currentIndex], currentIndex, workerSlot)
    }
  })
  await Promise.all(runners)
  return results
}

export function executePreparedGsWorkers(
  entries: PreparedGsToIrEntry[],
  options: { maxParallel: number; compact: boolean; profile: boolean }
): Promise<Array<GsToIrTaskProfile | undefined>> {
  const batchStart = options.profile ? performance.now() : 0
  const env = { ...process.env }
  return runWithLimit(entries, options.maxParallel, (item, originalIndex, workerSlot) =>
    runWorker(
      item.entry,
      item.runtimeEntry,
      item.outFile,
      options.compact,
      env,
      options.profile,
      options.profile
        ? {
            batchStart,
            originalIndex,
            workerSlot,
            estimatedCostBytes: fs.statSync(item.runtimeEntry).size
          }
        : undefined
    )
  )
}

function runWorkerCoordinator(
  request: GsWorkerBatchRequest,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<Array<GsToIrTaskProfile | undefined>> {
  return new Promise((resolve, reject) => {
    const child = fork(batchRunnerJsPath, [], {
      cwd,
      env,
      execArgv: getFileExecArgv(),
      stdio: ['inherit', 'inherit', 'pipe', 'ipc']
    })
    let response: GsWorkerBatchResponse | undefined
    let settled = false
    child.stderr?.on('data', (chunk: Buffer | string) => process.stderr.write(chunk))
    child.on('message', (message: GsWorkerBatchResponse) => {
      if (message?.kind === 'gsts-gs-worker-batch-result') response = message
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code !== 0 || !response || response.error) {
        const serialized = response?.error
        if (!serialized) {
          reject(new Error('[error] gs_to_ir_json worker coordinator failed'))
          return
        }
        const error = new Error(serialized.message)
        error.name = serialized.name
        if (serialized.stack) error.stack = serialized.stack
        if (serialized.code !== undefined) {
          ;(error as Error & { code?: string | number }).code = serialized.code
        }
        reject(error)
        return
      }
      resolve(response?.profiles ?? [])
    })
    child.send(request, (error) => {
      if (!error || settled) return
      settled = true
      child.kill()
      reject(error)
    })
  })
}

export async function emitIrJsonForEntries(
  entries: string[],
  opts: GsToJsonOptions = {}
): Promise<void> {
  if (!entries.length) return
  const list = entries.map((entry) => {
    const absEntry = path.resolve(entry)
    const outFile = resolveIrOutputPath(absEntry)
    return { entry: absEntry, runtimeEntry: absEntry, outFile }
  })
  const maxParallel = Math.max(1, opts.maxParallel ?? Math.max(1, os.cpus().length - 1))
  const wallStart = opts.profile ? performance.now() : 0
  const precompileStart = opts.profile ? performance.now() : 0
  let precompileProfile: GsToJsCompileProfile | undefined
  let directNode = false
  if (opts.moduleFiles) {
    if (!opts.moduleRoot) {
      throw new Error('[error] moduleRoot is required when moduleFiles is provided')
    }
    const compiled = await compileGsModulesToJs({
      moduleFiles: opts.moduleFiles,
      rootDir: opts.moduleRoot,
      profile: opts.profile
    })
    precompileProfile = compiled.profile
    const compiledSet = new Set(compiled.outFiles.map((file) => path.resolve(file)))
    for (const item of list) {
      item.runtimeEntry = resolveGsJsOutputPath(item.entry)
      if (!compiledSet.has(item.runtimeEntry)) {
        throw new Error(`[error] entry module was not precompiled: ${item.entry}`)
      }
    }
    directNode = runnerPath === runnerJsPath
  }
  const precompileMs = opts.profile ? performance.now() - precompileStart : 0
  const executeStart = opts.profile ? performance.now() : 0
  const runnerCwd = path.resolve(opts.cwd ?? process.cwd())
  const canUseWorker = directNode && fs.existsSync(batchRunnerJsPath)
  const env = { ...process.env }
  if (opts.runtimeOptions?.precompileExpression !== undefined) {
    env.GSTS_PRECOMPILE_EXPR = opts.runtimeOptions.precompileExpression ? '1' : '0'
  }
  if (opts.runtimeOptions?.removeUnusedNodes !== undefined) {
    env.GSTS_REMOVE_UNUSED_NODES = opts.runtimeOptions.removeUnusedNodes ? '1' : '0'
  }
  if (opts.lang) env.GSTS_RUNNER_LANG = opts.lang
  if (opts.profile) env.GSTS_PIPELINE_PROFILE = '1'
  const profiles = canUseWorker
    ? await runWorkerCoordinator(
        {
          kind: 'gsts-gs-worker-batch',
          entries: list,
          maxParallel,
          compact: !!opts.compact,
          profile: !!opts.profile
        },
        runnerCwd,
        env
      )
    : await runWithLimit(list, maxParallel, (item, originalIndex, workerSlot) =>
        spawnRunner(
          item.entry,
          item.runtimeEntry,
          item.outFile,
          !!opts.compact,
          directNode,
          opts.cwd,
          opts.runtimeOptions,
          opts.profile,
          opts.lang,
          opts.profile
            ? {
                batchStart: executeStart,
                originalIndex,
                workerSlot,
                estimatedCostBytes: fs.statSync(item.runtimeEntry).size
              }
            : undefined
        )
      )
  const executeMs = opts.profile ? performance.now() - executeStart : 0
  if (!opts.profile) return

  const tasks = profiles.filter((item): item is GsToIrTaskProfile => !!item)
  const sumTaskWallMs = tasks.reduce((sum, item) => sum + item.wallMs, 0)
  const sumChildMs = tasks.reduce((sum, item) => sum + (item.child?.timingsMs.total ?? 0), 0)
  const sumStartupOverheadMs = tasks.reduce((sum, item) => sum + (item.startupOverheadMs ?? 0), 0)
  opts.onProfile?.({
    stats: {
      tasks: tasks.length,
      modules: opts.moduleFiles?.length ?? 0,
      runner: canUseWorker ? 'worker' : directNode ? 'node' : 'tsx',
      maxParallel,
      sumTaskWallMs,
      sumChildMs,
      sumStartupOverheadMs
    },
    timingsMs: {
      precompile: precompileMs,
      execute: executeMs,
      wall: performance.now() - wallStart
    },
    ...(precompileProfile ? { precompile: precompileProfile } : {}),
    tasks
  })
}
