import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  emitIrJsonForEntries,
  resolveIrOutputPath
} from '../dist/src/compiler/gs_to_ir_json_transform/index.js'
import { compileGsModulesToJs } from '../dist/src/compiler/gs_to_js_pipeline.js'
import { compileTsToGs, createTsToGsProgramCache } from '../dist/src/compiler/ts_to_gs_pipeline.js'

const repoRoot = path.resolve(import.meta.dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(repoRoot, '.gsts-precompile-test-'))
const sourceRoot = path.join(tempRoot, 'source')
const outDir = path.join(tempRoot, 'out')

try {
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.writeFileSync(
    path.join(tempRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        baseUrl: './source',
        paths: { '@fixture/*': ['./*'] }
      }
    }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(sourceRoot, 'entry.ts'),
    `import { g } from 'genshin-ts/runtime/core'
import '@fixture/helper'

await import(\`./dynamic\`)

if (process.env.GSTS_EXPECT_CWD && process.cwd() !== process.env.GSTS_EXPECT_CWD) {
  throw new Error('unexpected cwd: ' + process.cwd())
}

g.server({ id: 1073742999 }).on('whenEntityIsCreated', (_evt, f) => {
  f.printString('precompile-ok')
})
`,
    'utf8'
  )
  fs.writeFileSync(
    path.join(sourceRoot, 'helper.ts'),
    `import { readHelperValue } from './cycle.js'

export const helperValue = 'helper'
export function readCycleValue() {
  return readHelperValue()
}
`,
    'utf8'
  )
  fs.writeFileSync(
    path.join(sourceRoot, 'cycle.ts'),
    `import { helperValue } from './helper.js'

export function readHelperValue() {
  return helperValue
}
`,
    'utf8'
  )
  fs.writeFileSync(path.join(sourceRoot, 'dynamic.ts'), `export const value = 'dynamic'\n`, 'utf8')

  const compileConfig = {
    compileRoot: 'source',
    entries: ['**/*.ts'],
    outDir: 'out'
  }
  const programCache = createTsToGsProgramCache()
  const result = await compileTsToGs({
    cfgDir: tempRoot,
    cfg: compileConfig,
    programCache,
    profile: true
  })

  assert.equal(result.entryOutFiles.length, 1)
  assert.equal(result.sourceFiles.length, 4)
  assert.equal(result.runtimeSourceFiles.length, 4)
  assert.equal(result.moduleOutFiles.length, 4)
  assert.ok(result.sourceFiles.some((file) => file.endsWith('helper.ts')))
  assert.ok(result.sourceFiles.some((file) => file.endsWith('cycle.ts')))
  assert.ok(result.sourceFiles.some((file) => file.endsWith('dynamic.ts')))
  assert.equal(result.profile?.stats.programReused, false)
  assert.ok((result.profile?.stats.sourceFilesCreated ?? 0) > 0)

  const firstProgram = programCache.program
  const entrySourceBefore = firstProgram?.getSourceFile(path.join(sourceRoot, 'entry.ts'))
  const helperSourceBefore = firstProgram?.getSourceFile(path.join(sourceRoot, 'helper.ts'))
  fs.writeFileSync(
    path.join(sourceRoot, 'helper.ts'),
    `import { readHelperValue } from './cycle.js'

export const helperValue = 'helper-updated'
export function readCycleValue() {
  return readHelperValue()
}
`,
    'utf8'
  )
  const incremental = await compileTsToGs({
    cfgDir: tempRoot,
    cfg: compileConfig,
    emitEntries: ['helper.ts', 'entry.ts'],
    programEntries: compileConfig.entries,
    programCache,
    invalidatedFiles: [path.join(sourceRoot, 'helper.ts')],
    profile: true
  })
  assert.equal(incremental.profile?.stats.programReused, true)
  assert.ok((incremental.profile?.stats.sourceFilesReused ?? 0) > 0)
  assert.equal(
    programCache.program?.getSourceFile(path.join(sourceRoot, 'entry.ts')),
    entrySourceBefore
  )
  assert.notEqual(
    programCache.program?.getSourceFile(path.join(sourceRoot, 'helper.ts')),
    helperSourceBefore
  )
  assert.match(fs.readFileSync(path.join(outDir, 'helper.gs.ts'), 'utf8'), /helper-updated/)

  const addedFile = path.join(sourceRoot, 'added.ts')
  fs.writeFileSync(addedFile, `export const added = true\n`, 'utf8')
  await compileTsToGs({
    cfgDir: tempRoot,
    cfg: compileConfig,
    emitEntries: ['added.ts'],
    programEntries: compileConfig.entries,
    programCache,
    invalidatedFiles: [addedFile]
  })
  assert.ok(programCache.program?.getSourceFile(addedFile))
  fs.rmSync(addedFile)
  await compileTsToGs({
    cfgDir: tempRoot,
    cfg: compileConfig,
    emitEntries: ['entry.ts'],
    programEntries: compileConfig.entries,
    programCache,
    invalidatedFiles: [addedFile]
  })
  assert.equal(programCache.program?.getSourceFile(addedFile), undefined)

  const entryFile = result.entryOutFiles[0]
  const generatedEntry = fs.readFileSync(entryFile, 'utf8')
  assert.match(generatedEntry, /['"]\.\/helper\.gs\.js['"];/)
  assert.match(generatedEntry, /import\(['"]\.\/dynamic\.gs\.js['"]\)/)

  let fallbackProfile
  await emitIrJsonForEntries(result.entryOutFiles, {
    cwd: repoRoot,
    profile: true,
    onProfile: (profile) => (fallbackProfile = profile),
    runtimeOptions: { precompileExpression: false, removeUnusedNodes: false }
  })
  assert.equal(fallbackProfile?.stats.runner, 'tsx')
  const irPath = resolveIrOutputPath(entryFile)
  const fallbackIr = fs.readFileSync(irPath, 'utf8')

  let directProfile
  await emitIrJsonForEntries(result.entryOutFiles, {
    cwd: repoRoot,
    moduleFiles: result.moduleOutFiles,
    moduleRoot: result.outDir,
    profile: true,
    onProfile: (profile) => (directProfile = profile),
    runtimeOptions: { precompileExpression: false, removeUnusedNodes: false }
  })
  assert.equal(directProfile?.stats.runner, 'worker')
  assert.equal(directProfile?.stats.modules, 4)
  for (const gsFile of result.moduleOutFiles) {
    const jsFile = gsFile.replace(/\.gs\.ts$/i, '.gs.js')
    assert.ok(fs.existsSync(jsFile), `Expected ${jsFile}`)
    assert.ok(fs.existsSync(`${jsFile}.map`), `Expected ${jsFile}.map`)
  }

  const directIr = fs.readFileSync(irPath, 'utf8')
  const directDocs = JSON.parse(directIr)
  assert.equal(directDocs[0]?.graph?.name, '_GSTS_entry')
  assert.equal(directIr, fallbackIr)

  let cwdProfile
  process.env.GSTS_EXPECT_CWD = tempRoot
  try {
    await emitIrJsonForEntries(result.entryOutFiles, {
      cwd: tempRoot,
      moduleFiles: result.moduleOutFiles,
      moduleRoot: result.outDir,
      profile: true,
      onProfile: (profile) => (cwdProfile = profile),
      runtimeOptions: { precompileExpression: false, removeUnusedNodes: false }
    })
  } finally {
    delete process.env.GSTS_EXPECT_CWD
  }
  assert.equal(cwdProfile?.stats.runner, 'worker')
  assert.equal(fs.readFileSync(irPath, 'utf8'), directIr)

  const failingGsFile = path.join(outDir, 'source-map-check.gs.ts')
  fs.writeFileSync(
    failingGsFile,
    `const lineOne = 1\nthrow new Error('source-map-check')\n`,
    'utf8'
  )
  await compileGsModulesToJs({
    moduleFiles: [failingGsFile],
    rootDir: outDir
  })
  let workerStderr = ''
  const stderrWrite = process.stderr.write
  process.stderr.write = (chunk, ...args) => {
    workerStderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    return true
  }
  try {
    await assert.rejects(
      emitIrJsonForEntries([failingGsFile], {
        cwd: repoRoot,
        moduleFiles: [failingGsFile],
        moduleRoot: outDir
      }),
      (error) => {
        assert.equal(error.message, `[error] gs_to_ir_json failed: ${failingGsFile}`)
        return true
      }
    )
  } finally {
    process.stderr.write = stderrWrite
  }
  assert.match(workerStderr, /Error: source-map-check/)
  assert.match(workerStderr, /source-map-check\.gs\.ts:2/)

  const workerApiUrl = new URL(
    '../dist/src/compiler/gs_to_ir_json_transform/index.js',
    import.meta.url
  ).href
  const failedProcess = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { emitIrJsonForEntries } from ${JSON.stringify(workerApiUrl)};
await emitIrJsonForEntries([${JSON.stringify(failingGsFile)}], {
  cwd: ${JSON.stringify(repoRoot)},
  moduleFiles: [${JSON.stringify(failingGsFile)}],
  moduleRoot: ${JSON.stringify(outDir)}
})`
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  assert.notEqual(failedProcess.status, 0)
  assert.match(failedProcess.stderr, /source-map-check\.gs\.ts:2/)
  assert.match(failedProcess.stderr, /\[error\] gs_to_ir_json failed:/)

  const sourceMapRun = spawnSync(
    process.execPath,
    ['--enable-source-maps', failingGsFile.replace(/\.gs\.ts$/i, '.gs.js')],
    { encoding: 'utf8' }
  )
  assert.notEqual(sourceMapRun.status, 0)
  assert.match(sourceMapRun.stderr, /source-map-check\.gs\.ts:2/)

  console.log(
    '[ok] GS incremental Program, dependency precompile, Worker failure, source maps, and TSX equivalence'
  )
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
