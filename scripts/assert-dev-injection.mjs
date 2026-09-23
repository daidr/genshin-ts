import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildFile, encodeVarint, parseMessage } from '../dist/src/injector/binary.js'
import { buildNodeGraphFieldIndex } from '../dist/src/injector/node_graph.js'
import { loadGiaProto } from '../dist/src/injector/proto.js'

fs.mkdirSync('.tmp', { recursive: true })
const study = fs.mkdtempSync(path.resolve('.tmp/dev-injection-test-')),
  proto = loadGiaProto()
const hook = path.join(study, 'stop.mjs')
fs.writeFileSync(
  hook,
  `import fs from 'node:fs'
import {isMainThread} from 'node:worker_threads'
if(isMainThread) fs.writeFileSync(process.env.REVIEW_LOGS+'/'+process.pid+'.pid', String(process.pid))
process.on('message', m => { if(m === 'review-stop') process.exit(0) })`
)
const ids = [1073742801, 1073742802, 1082130603],
  header = { schema: 1, headTag: 0x0326, fileType: 0, tailTag: 0x0679 }
const cat = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)))
const vf = (n, v) => cat(encodeVarint(n << 3), encodeVarint(v))
const bf = (n, v) => cat(encodeVarint((n << 3) | 2), encodeVarint(v.length), v)
function mapBytes(label) {
  const graphs = ids.map((id) =>
    bf(
      10,
      bf(
        1,
        bf(
          1,
          proto.nodeGraphMessage
            .encode({
              id: { class: 10000, type: id === ids[2] ? 20002 : 20000, kind: 21001, id },
              name: 'empty',
              nodes: []
            })
            .finish()
        )
      )
    )
  )
  const prefab = bf(
    4,
    bf(1, cat(vf(1, 987654), vf(2, 1001), bf(6, bf(11, bf(1, Buffer.from(`Prefab_${label}`))))))
  )
  const signalId = bf(4, bf(1, cat(vf(1, 10001), vf(2, 20000), vf(3, 22000), vf(5, 456789))))
  const signalName = bf(107, bf(101, bf(1, Buffer.from(`Signal_${label}`))))
  const signal = bf(10, bf(2, bf(1, cat(signalId, signalName))))
  return buildFile(cat(...graphs, prefab, signal), header)
}
function graphs(file) {
  const bytes = fs.readFileSync(file),
    payload = bytes.subarray(20, -4),
    fields = [],
    nodeGraphBlobFields = []
  parseMessage(payload, 0, payload.length, 0, 0, 0, 0, 0, 0, 0, fields, { nodeGraphBlobFields })
  return Object.fromEntries(
    [...buildNodeGraphFieldIndex(payload, nodeGraphBlobFields)].map(([id, m]) => [
      id,
      proto.nodeGraphMessage.toObject(
        proto.nodeGraphMessage.decode(payload.subarray(m[0].field.dataStart, m[0].field.dataEnd)),
        { longs: Number }
      )
    ])
  )
}
const source = (id, text) =>
  `import {g} from 'genshin-ts/runtime/core'\ng.server({id:${id},name:'_GSTS_review'}).on('whenEntityIsCreated',(_evt,f)=>{f.printString('${text}')})\n`
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function fixture(name, withEntries = true, nested = false) {
  const dir = path.join(study, name),
    src = path.join(dir, 'src'),
    logs = path.join(dir, 'logs'),
    appData = path.join(dir, 'AppData'),
    player = path.join(
      appData,
      'LocalLow/miHoYo/原神/BeyondLocal/100431567/Beyond_Local_Save_Level'
    )
  for (const d of [src, logs, player, path.join(appData, 'Roaming/genshin-ts')])
    fs.mkdirSync(d, { recursive: true })
  const gil = path.join(player, ...(nested ? ['1073741851'] : []), '1073741851.gil')
  fs.mkdirSync(path.dirname(gil), { recursive: true })
  fs.writeFileSync(gil, mapBytes('initial'))
  fs.writeFileSync(
    path.join(appData, 'Roaming/genshin-ts/state.json'),
    JSON.stringify({ updateCheck: { lastAt: Date.now() }, noticeCheck: { lastAt: Date.now() } })
  )
  fs.writeFileSync(
    path.join(src, 'a.ts'),
    withEntries ? source(ids[0], 'initial-A') : 'export const helper = 1\n'
  )
  if (withEntries) fs.writeFileSync(path.join(src, 'b.ts'), source(ids[0], 'initial-B'))
  const cfg = {
    compileRoot: './src',
    entries: ['./*.ts'],
    outDir: './out',
    lang: 'en-US',
    inject: {
      gameRegion: 'China',
      playerId: 100431567,
      mapId: 1073741851,
      resourcesPath: 'generated/prefabs.ts',
      signalsPath: 'generated/signals.ts'
    },
    options: { optimize: { precompileExpression: false, removeUnusedNodes: false } }
  }
  const config = path.join(dir, 'gsts.config.mjs')
  fs.writeFileSync(config, `export default ${JSON.stringify(cfg)}`)
  const child = fork(
    path.resolve('dist/src/cli/gsts.js'),
    ['dev', '-c', config, '--inject-profile', '--lang', 'en-US'],
    {
      cwd: dir,
      execArgv: [],
      env: {
        ...process.env,
        APPDATA: path.join(appData, 'Roaming'),
        LOCALAPPDATA: path.join(appData, 'Local'),
        REVIEW_LOGS: logs,
        NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    }
  )
  let stdout = '',
    stderr = '',
    exited = false
  const profiles = []
  let lineBuffer = ''
  child.stdout.on('data', (data) => {
    stdout += data
    lineBuffer += data
    while (lineBuffer.includes('\n')) {
      const at = lineBuffer.indexOf('\n'),
        line = lineBuffer.slice(0, at)
      lineBuffer = lineBuffer.slice(at + 1)
      const m = line.match(/^\[(inject-profile|extract-profile)\]\s+(.*)$/)
      if (m) profiles.push({ kind: m[1], time: performance.now(), value: JSON.parse(m[2]) })
    }
  })
  child.stderr.on('data', (data) => (stderr += data))
  child.on('exit', () => (exited = true))
  async function wait(check, label) {
    const until = performance.now() + 45000
    while (!check()) {
      if (exited) throw new Error(`Exited ${label}: ${stderr}`)
      if (performance.now() > until) throw new Error(`Timeout ${label}\n${stdout}\n${stderr}`)
      await delay(30)
    }
  }
  async function stop() {
    fs.writeFileSync(path.join(logs, 'stdout.log'), stdout)
    fs.writeFileSync(path.join(logs, 'stderr.log'), stderr)
    fs.writeFileSync(path.join(logs, 'profiles.json'), JSON.stringify(profiles, null, 2))
    if (child.connected) child.send('review-stop')
    if (!exited) await new Promise((resolve) => child.once('exit', resolve))
    const remaining = []
    for (const file of fs.readdirSync(logs).filter((f) => f.endsWith('.pid'))) {
      try {
        const pid = Number(file.slice(0, -4))
        process.kill(pid, 0)
        remaining.push(pid)
      } catch {}
    }
    assert.deepEqual(remaining, [])
  }
  const injectCount = () => profiles.filter((p) => p.kind === 'inject-profile').length,
    extractCount = () => profiles.filter((p) => p.kind === 'extract-profile').length
  const artifact = () => fs.readFileSync(path.join(dir, 'generated/prefabs.ts'), 'utf8')
  return {
    get stderr() {
      return stderr
    },
    dir,
    src,
    gil,
    profiles,
    wait,
    stop,
    injectCount,
    extractCount,
    artifact,
    get stdout() {
      return stdout
    }
  }
}

async function settleEdit(f, file, text) {
  const from = f.stdout.length
  if (text === null) fs.unlinkSync(path.join(f.src, file))
  else fs.writeFileSync(path.join(f.src, file), text)
  if (text !== null)
    await f.wait(
      () => f.stdout.slice(from).includes(file.replace(/\.ts$/, '.gs.ts')),
      'compile ' + file
    )
  await delay(1300)
}
async function saveMap(f, label) {
  // Compilation can finish late; let the CLI's self-write cooldown expire before saving.
  const lastInject = f.profiles.findLast((p) => p.kind === 'inject-profile')
  if (lastInject) await delay(Math.max(0, lastInject.time + 1100 - performance.now()))
  const n = f.extractCount()
  fs.writeFileSync(f.gil, mapBytes(label))
  await f.wait(() => f.extractCount() > n, 'extract ' + label)
  await delay(1000)
  return graphs(f.gil)
}
const f = await fixture('entries')
try {
  await f.wait(() => f.extractCount() >= 1, 'initial')
  await delay(1100)
  // A failed output is not injectable, but must remain pending for map-save recovery.
  const failedGia = path.join(f.dir, 'out/review_1073742801.gia')
  fs.unlinkSync(failedGia)
  fs.mkdirSync(failedGia)
  const beforeFailure = f.injectCount()
  await settleEdit(f, 'a.ts', source(ids[0], 'recovered-A'))
  await f.wait(() => f.stderr.includes('ir_to_gia failed'), 'expected GIA write failure')
  assert.equal(f.injectCount(), beforeFailure)
  // A successful unrelated graph must not clear the pending failed graph.
  await settleEdit(f, 'unrelated.ts', source(ids[1], 'unrelated'))
  // An unsuccessful map-save retry must keep the graph pending for the following save.
  const errorOffset = f.stderr.length
  const beforeRetry = f.injectCount()
  fs.writeFileSync(f.gil, mapBytes('still-blocked'))
  await f.wait(() => f.stderr.slice(errorOffset).includes('ir_to_gia failed'), 'failed map retry')
  await delay(1100)
  assert.equal(f.injectCount(), beforeRetry)
  fs.rmdirSync(failedGia)
  const recovered = await saveMap(f, 'recovered')
  assert.ok(fs.statSync(failedGia).isFile())
  assert.ok(JSON.stringify(recovered[ids[0]]).includes('recovered-A'))
  assert.ok(JSON.stringify(recovered[ids[0]]).includes('initial-B'))
  assert.ok(!JSON.stringify(recovered[ids[0]]).includes('initial-A'))
  await settleEdit(f, 'unrelated.ts', null)
  await settleEdit(f, 'a.ts', source(ids[1], 'moved-A'))
  let g = await saveMap(f, 'moved')
  assert.ok(!JSON.stringify(g[ids[0]]).includes('initial-A'))
  assert.ok(JSON.stringify(g[ids[0]]).includes('initial-B'))
  assert.ok(JSON.stringify(g[ids[1]]).includes('moved-A'))
  assert.ok(!fs.existsSync(path.join(f.dir, 'out/review_1073742801.json')))

  // One source now participates in two graphs, both shared with other sources.
  await settleEdit(
    f,
    'a.ts',
    source(ids[0], 'shared-A') +
      source(ids[1], 'other-A').replace("import {g} from 'genshin-ts/runtime/core'\n", '')
  )
  await settleEdit(f, 'c.ts', source(ids[1], 'other-C'))
  await settleEdit(f, 'b.ts', source(ids[0], 'updated-B'))
  g = await saveMap(f, 'connected')
  for (const text of ['shared-A', 'updated-B']) assert.ok(JSON.stringify(g[ids[0]]).includes(text))
  for (const text of ['other-A', 'other-C']) assert.ok(JSON.stringify(g[ids[1]]).includes(text))
  // Remove only one declaration, keeping the file an entry.
  await settleEdit(f, 'a.ts', source(ids[0], 'remaining-A'))
  g = await saveMap(f, 'partial-removal')
  assert.ok(!JSON.stringify(g[ids[1]]).includes('other-A'))
  assert.ok(JSON.stringify(g[ids[1]]).includes('other-C'))
  assert.ok(JSON.stringify(g[ids[0]]).includes('remaining-A'))

  // Retire a complete entry without deleting its source file.
  await settleEdit(f, 'a.ts', 'export const helper = 2\n')
  g = await saveMap(f, 'retired')
  assert.ok(!JSON.stringify(g[ids[0]]).includes('remaining-A'))
  assert.ok(JSON.stringify(g[ids[0]]).includes('updated-B'))
  await settleEdit(f, 'c.ts', null)
  g = await saveMap(f, 'unlinked')
  assert.equal(g[ids[1]].nodes?.length ?? 0, 0)

  // Client entry removal follows the same compiler result, not a server-only text match.
  await settleEdit(
    f,
    'skill.ts',
    `import {g} from 'genshin-ts/runtime/core'
g.characterSkill({id:${ids[2]},name:'_GSTS_skill'}).on('start',(_evt,_f)=>{})
`
  )
  await saveMap(f, 'skill')
  let p = f.profiles.filter((p) => p.kind === 'inject-profile').at(-1).value
  assert.ok(
    p.items.some((i) => i.targetId === ids[2] && i.status === 'ok'),
    JSON.stringify(p)
  )
  await settleEdit(f, 'skill.ts', 'export const helper = 3\n')
  await saveMap(f, 'no-skill')
  p = f.profiles.filter((p) => p.kind === 'inject-profile').at(-1).value
  assert.ok(!p.items.some((i) => i.targetId === ids[2]))

  // Retiring a failed graph must also retire its pending rebuild state.
  const retiredGia = path.join(f.dir, 'out/b.gia')
  assert.ok(fs.existsSync(retiredGia))
  fs.unlinkSync(retiredGia)
  fs.mkdirSync(retiredGia)
  const retiredErrorOffset = f.stderr.length
  await settleEdit(f, 'b.ts', source(ids[0], 'retire-after-failure'))
  await f.wait(
    () => f.stderr.slice(retiredErrorOffset).includes('ir_to_gia failed'),
    'retired failure'
  )
  fs.rmdirSync(retiredGia)
  await settleEdit(f, 'b.ts', 'export const helper = 4\n')
  const injections = f.injectCount()
  await saveMap(f, 'none')
  assert.equal(f.injectCount(), injections)
  assert.ok(f.artifact().includes('Prefab_none'))
  assert.ok(
    fs.readFileSync(path.join(f.dir, 'generated/signals.ts'), 'utf8').includes('Signal_none')
  )
} finally {
  await f.stop()
}
const empty = await fixture('no-entries', false)
try {
  await empty.wait(() => empty.extractCount() >= 1, 'empty initial')
  await delay(1100)
  await saveMap(empty, 'empty-updated')
  assert.equal(empty.injectCount(), 0)
  assert.ok(empty.artifact().includes('Prefab_empty-updated'))
} finally {
  await empty.stop()
}
const nested = await fixture('nested-map', true, true)
try {
  await nested.wait(() => nested.extractCount() >= 1, 'nested initial')
  assert.ok(JSON.stringify(graphs(nested.gil)[ids[0]]).includes('initial-A'))
  await delay(1100)
  const g = await saveMap(nested, 'nested-updated')
  assert.ok(JSON.stringify(g[ids[0]]).includes('initial-A'))
  assert.ok(JSON.stringify(g[ids[0]]).includes('initial-B'))
  assert.ok(nested.artifact().includes('Prefab_nested-updated'))
  assert.ok(!fs.existsSync(path.join(path.dirname(path.dirname(nested.gil)), '1073741851.gil')))
} finally {
  await nested.stop()
}
console.log(
  '[ok] dev failure recovery, graph migration, connected merges, entry removal and no-GIA extraction'
)
console.log('Artifacts:', path.relative(process.cwd(), study))
