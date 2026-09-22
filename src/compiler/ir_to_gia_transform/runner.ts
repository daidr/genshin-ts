import readline from 'node:readline'

import {
  counter_dynamic_id,
  counter_index
} from '../../thirdparty/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack/gia_gen/utils.js'
import {
  writeGiaFromIrJsonFile,
  type GiaWriteFileProfile,
  type WriteGiaFromIrJsonFileOptions
} from './shared.js'

function parseIndicesCsv(csv: string | undefined): number[] | undefined {
  if (!csv) return undefined
  const trimmed = csv.trim()
  if (!trimmed) return undefined
  return trimmed
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n))
}

type WorkerRequest = {
  id: number
  irPath: string
  outFile?: string
  opts?: WriteGiaFromIrJsonFileOptions
  profile: boolean
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  return (
    Number.isInteger(request.id) &&
    typeof request.irPath === 'string' &&
    (request.outFile === undefined || typeof request.outFile === 'string') &&
    typeof request.profile === 'boolean'
  )
}

function runTask(request: WorkerRequest) {
  // Previously each input file ran in a fresh process. Preserve that counter boundary while
  // keeping protobuf/module caches, and keep counters continuous across documents in this file.
  counter_dynamic_id.reset()
  counter_index.reset()
  let profile: GiaWriteFileProfile | undefined
  const outputs = writeGiaFromIrJsonFile(
    request.irPath,
    request.outFile,
    request.opts,
    (x) => process.stderr.write(`[ok] ${x.giaPath} (id=${x.graphId})\n`),
    request.profile ? (value) => (profile = value) : undefined
  )
  return { outputs, profile }
}

async function runWorker() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let id: number | undefined
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isWorkerRequest(parsed)) throw new Error('[error] invalid ir_to_gia worker request')
      id = parsed.id
      const result = runTask(parsed)
      process.stdout.write(`${JSON.stringify({ id, ...result })}\n`)
    } catch (error) {
      const stack = error instanceof Error ? (error.stack ?? error.message) : String(error)
      process.stderr.write(`${stack}\n`)
      process.stdout.write(`${JSON.stringify({ id, error: stack })}\n`)
    }
  }
}

function runSingle() {
  const [irPathArg, outFileArg, preserveFlag, indicesCsv] = process.argv.slice(2)
  if (!irPathArg) {
    console.error('[error] irPath is required')
    process.exit(1)
  }

  const irPath = irPathArg
  const outFile = outFileArg || undefined
  const preserveIndices = preserveFlag === '1'
  const includeIndices = parseIndicesCsv(indicesCsv)

  const { outputs, profile } = runTask({
    id: 0,
    irPath,
    outFile,
    opts: { includeIndices, preserveIndices },
    profile: process.env.GSTS_PIPELINE_PROFILE === '1'
  })
  if (profile) {
    process.stderr.write(`[gsts-profile:ir-to-gia] ${JSON.stringify(profile)}\n`)
  }
  process.stdout.write(JSON.stringify(outputs))
}

try {
  if (process.argv[2] === '--worker') {
    await runWorker()
  } else {
    runSingle()
  }
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
}
