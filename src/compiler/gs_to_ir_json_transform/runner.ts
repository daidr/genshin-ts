import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'

import { initCliI18n } from '../../i18n/index.js'
import { buildAllGraphRegistriesIRDocuments } from '../../runtime/core.js'
import { setRuntimeOptions } from '../../runtime/runtime_config.js'

function defaultGraphNameFromEntryFile(entryFile: string): string {
  const base = path.basename(entryFile)
  // 入口可能由 tsx 直接运行 .gs.ts，也可能预编译后由 Node 运行 .gs.js。
  if (/\.gs\.(?:ts|js)$/i.test(base)) return base.replace(/\.gs\.(?:ts|js)$/i, '')
  return path.basename(entryFile, path.extname(entryFile))
}

type WorkerRunnerData = {
  kind: 'gsts-gs-to-ir'
  entryFile: string
  outFile: string
  compact: boolean
}

async function main(entryFile: string, outFile: string, compact: boolean) {
  if (!entryFile || !outFile) throw new Error('[error] entryFile and outFile are required')
  const profiling = process.env.GSTS_PIPELINE_PROFILE === '1'
  const totalStart = profiling ? performance.now() : 0

  setRuntimeOptions({
    optimize: {
      precompileExpression: process.env.GSTS_PRECOMPILE_EXPR === '1',
      removeUnusedNodes: process.env.GSTS_REMOVE_UNUSED_NODES === '1'
    }
  })

  const runnerLang = process.env.GSTS_RUNNER_LANG
  if (runnerLang === 'zh-CN' || runnerLang === 'en-US') initCliI18n(runnerLang)

  const entryUrl = pathToFileURL(entryFile).href
  const importStart = profiling ? performance.now() : 0
  await import(entryUrl)
  const importEntryMs = profiling ? performance.now() - importStart : 0

  const space = compact ? 0 : 2
  const buildStart = profiling ? performance.now() : 0
  const documents = buildAllGraphRegistriesIRDocuments({
    defaultName: defaultGraphNameFromEntryFile(entryFile)
  })
  const buildDocumentsMs = profiling ? performance.now() - buildStart : 0
  const stringifyStart = profiling ? performance.now() : 0
  const json =
    JSON.stringify(
      // defaultName：当脚本内未传 g.server({ name }) 时，用入口文件名自动命名
      documents,
      null,
      space
    ) + '\n'
  const stringifyMs = profiling ? performance.now() - stringifyStart : 0

  const writeStart = profiling ? performance.now() : 0
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, json, 'utf8')
  const writeMs = profiling ? performance.now() - writeStart : 0
  const profile = profiling
    ? {
        stats: {
          inputBytes: fs.statSync(entryFile).size,
          outputBytes: Buffer.byteLength(json),
          documents: documents.length,
          nodes: documents.reduce((sum, doc) => sum + (doc.nodes?.length ?? 0), 0),
          variables: documents.reduce((sum, doc) => sum + (doc.variables?.length ?? 0), 0)
        },
        timingsMs: {
          importEntry: importEntryMs,
          buildDocuments: buildDocumentsMs,
          stringify: stringifyMs,
          write: writeMs,
          total: performance.now() - totalStart
        }
      }
    : undefined
  console.log(`[ok] ${outFile}`)
  return profile
}

const data = workerData as WorkerRunnerData | null
const args = isMainThread
  ? {
      kind: 'gsts-gs-to-ir' as const,
      entryFile: process.argv[2] ?? '',
      outFile: process.argv[3] ?? '',
      compact: process.argv[4] === '1'
    }
  : data?.kind === 'gsts-gs-to-ir'
    ? data
    : { kind: 'gsts-gs-to-ir', entryFile: '', outFile: '', compact: false }

main(args.entryFile, args.outFile, args.compact)
  .then((profile) => {
    if (isMainThread) {
      if (profile) process.stderr.write(`[gsts-profile:gs-to-ir] ${JSON.stringify(profile)}\n`)
    } else {
      parentPort?.postMessage({ kind: 'gsts-gs-to-ir-result', profile })
    }
  })
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
