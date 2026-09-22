import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import protobuf from 'protobufjs'

import { wrap_gia } from '../dist/src/compiler/gia_vendor.js'
import {
  mergeIrJsonFilesByGraphId,
  mergeIrJsonFilesByGraphIdAsync
} from '../dist/src/compiler/ir_merge.js'
import {
  encodeProtobufLowMemory,
  wrapGiaLowMemory
} from '../dist/src/compiler/ir_to_gia_transform/encode_gia.js'
import { irToGia } from '../dist/src/compiler/ir_to_gia_transform/index.js'
import { writeGiaFromIrJsonFile } from '../dist/src/compiler/ir_to_gia_transform/shared.js'
import { initCliI18n } from '../dist/src/i18n/index.js'
import { DEFAULT_GIA_PROTO, loadGiaProto } from '../dist/src/injector/proto.js'
import { counter_dynamic_id } from '../dist/src/thirdparty/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack/gia_gen/utils.js'

initCliI18n('en-US')

function document(id, variables = []) {
  return {
    ir_version: 1,
    ir_type: 'node_graph',
    graph: { type: 'server', mode: 'beyond', sub_type: 'entity', id },
    variables,
    nodes: [{ id: 1, type: 'when_entity_is_created' }]
  }
}

test('sync/async merge bytes, metadata, repeated calls and error compatibility', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsts-merge-memory-'))
  try {
    const files = [
      document(1073742501),
      [document(1073742501), document(1073742502)],
      { ...document(1073742503), __gsts: { merged: true } },
      { unrelated: true }
    ].map((doc, index) => {
      const file = path.join(dir, `${index}.json`)
      fs.writeFileSync(file, JSON.stringify(doc))
      return file
    })
    const params = { outDirAbs: dir, irJsonPaths: [files[1], files[0], ...files.slice(2)] }
    const inputsBefore = files.map((file) => fs.readFileSync(file))
    const expected = mergeIrJsonFilesByGraphId(params)
    assert.ok(Array.isArray(expected), 'sync API must still return immediately')
    const outputBytes = expected.map((item) => fs.readFileSync(item.outJsonPath))
    for (let i = 0; i < 2; i++) {
      const actual = await mergeIrJsonFilesByGraphIdAsync(params)
      assert.deepEqual(actual, expected)
      assert.deepEqual(
        actual.map((item) => fs.readFileSync(item.outJsonPath)),
        outputBytes
      )
    }
    assert.deepEqual(
      files.map((file) => fs.readFileSync(file)),
      inputsBefore
    )
    assert.deepEqual(await mergeIrJsonFilesByGraphIdAsync({ ...params, irJsonPaths: [] }), [])

    // A later missing file must not mask an earlier JSON parse error, and no merge is written.
    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, '{broken')
    const mergedPath = expected.find((item) => item.mergedOutput).outJsonPath
    fs.writeFileSync(mergedPath, 'sentinel')
    const invalid = { ...params, irJsonPaths: [...files, broken, path.join(dir, 'missing.json')] }
    let original
    try {
      mergeIrJsonFilesByGraphId(invalid)
    } catch (error) {
      original = error
    }
    await assert.rejects(mergeIrJsonFilesByGraphIdAsync(invalid), (error) => {
      assert.ok(error instanceof SyntaxError)
      assert.equal(error.message, original.message)
      assert.ok(error.stack.includes('appendIrSources'))
      return true
    })
    assert.equal(fs.readFileSync(mergedPath, 'utf8'), 'sentinel')

    // Native read errors retain their code/path; async fs naturally has a different stack.
    const missing = path.join(dir, 'first-missing.json')
    await assert.rejects(
      mergeIrJsonFilesByGraphIdAsync({ ...params, irJsonPaths: [missing, broken] }),
      (error) => error.code === 'ENOENT' && error.path === missing
    )

    const duplicate = { name: 'userVar', type: 'int', value: 1 }
    fs.writeFileSync(files[0], JSON.stringify(document(1073742501, [duplicate])))
    fs.writeFileSync(files[1], JSON.stringify(document(1073742501, [duplicate])))
    const conflict = { ...params, irJsonPaths: files.slice(0, 2) }
    try {
      mergeIrJsonFilesByGraphId(conflict)
    } catch (error) {
      original = error
    }
    await assert.rejects(
      mergeIrJsonFilesByGraphIdAsync(conflict),
      (error) => error.message === original.message
    )
    assert.equal(fs.readFileSync(mergedPath, 'utf8'), 'sentinel')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('prefetch is bounded, stops dispatch on read failure, drains reads and throws the ordered original error', async () => {
  const originalRead = fs.promises.readFile
  const pending = []
  let active = 0,
    maxActive = 0
  const earlier = Object.assign(new Error('earlier failure'), { code: 'EACCES' })
  const later = new Error('later failure, completed first')
  try {
    fs.promises.readFile = (file) =>
      new Promise((resolve, reject) => {
        active++
        maxActive = Math.max(active, maxActive)
        pending.push({
          file,
          ok: () => {
            active--
            resolve('{}')
          },
          fail: (error) => {
            active--
            reject(error)
          }
        })
      })
    let finished = false
    const result = mergeIrJsonFilesByGraphIdAsync({
      outDirAbs: '.',
      irJsonPaths: Array.from({ length: 20 }, (_, i) => `file-${i}.json`)
    }).then(
      () => {
        finished = true
        return null
      },
      (error) => {
        finished = true
        return error
      }
    )
    assert.equal(pending.length, 8)
    pending[5].fail(later)
    await new Promise((resolve) => setImmediate(resolve))
    pending[0].ok()
    pending[1].fail(earlier)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(pending.length, 8, 'do not dispatch after a read failure is observed')
    assert.equal(finished, false, 'must drain already running reads')
    for (const i of [2, 3, 4, 6, 7]) pending[i].ok()
    assert.equal(await result, earlier)
    assert.equal(active, 0)
    assert.equal(maxActive, 8)
    pending.length = 0
    const success = mergeIrJsonFilesByGraphIdAsync({
      outDirAbs: '.',
      irJsonPaths: Array.from({ length: 20 }, (_, i) => `retry-${i}.json`)
    })
    for (let i = 0; i < 20; i++) {
      assert.equal(pending[i].file, `retry-${i}.json`)
      pending[i].ok()
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.deepEqual(await success, [])
    assert.equal(active, 0)
    assert.equal(maxActive, 8)
  } finally {
    fs.promises.readFile = originalRead
  }
})

test('low-memory protobuf matches scalar, nested, map, packed, optional and oneof bytes', () => {
  const { root } = protobuf.parse(`syntax="proto3";
    message Item {
      int32 a=1; uint32 b=2; sint32 c=3; int64 d=4; uint64 e=5; sint64 f=6;
      fixed32 g=7; sfixed32 h=8; fixed64 i=9; sfixed64 j=10;
      float k=11; double l=12; bool m=13; string n=14; bytes o=15;
      repeated int32 p=16 [packed=true]; repeated string q=17;
      map<string,Item> r=18; repeated Item s=19; Item t=20;
      oneof choice { int32 u=21; string v=22; }
    }`)
  const type = root.lookupType('Item')
  const ints = [
    0, 1, -1, 127, 128, 16383, 16384, 2097151, 2097152, 2147483647, -2147483648, 4294967295
  ]
  const longs = [
    '0',
    '1',
    '-1',
    '9223372036854775807',
    '-9223372036854775808',
    '18446744073709551615'
  ]
  const floats = [0, -0, NaN, Infinity, -Infinity, 1e-38, 1.23456789, Number.MAX_VALUE]
  const strings = ['', '中文😀', 'a'.repeat(500), '\ud800', '\udc00', 'a\u0000z']
  for (let x = 0; x < 600; x++) {
    const n = ints[x % ints.length],
      long = longs[x % longs.length],
      text = strings[x % strings.length]
    const data = type.fromObject({
      a: n,
      b: n,
      c: n,
      d: long,
      e: long,
      f: long,
      g: n,
      h: n,
      i: long,
      j: long,
      k: floats[x % floats.length],
      l: floats[(x + 1) % floats.length],
      m: !!(x % 2),
      n: text,
      o: Buffer.from([x & 255, 128, 255]),
      p: ints,
      q: strings,
      r: { a: { a: n }, 中文: { n: text } },
      s: [{}, { t: { t: { a: n } } }],
      t: { a: n },
      ...(x % 2 ? { u: n } : { v: text })
    })
    assert.deepEqual(encodeProtobufLowMemory(type, data), type.encode(data).finish(), `case ${x}`)
    assert.deepEqual(
      new Uint8Array(wrapGiaLowMemory(type, data)),
      new Uint8Array(wrap_gia(type, data))
    )
  }
  assert.deepEqual(encodeProtobufLowMemory(type, {}), type.encode({}).finish())
  const boom = new TypeError('original encoder failure')
  const invalid = Object.defineProperty({}, 'n', {
    get() {
      throw boom
    }
  })
  assert.throws(
    () => encodeProtobufLowMemory(type, invalid),
    (error) => error === boom
  )
  // General vendor API remains untouched: a stateful getter must see the old traversal.
  const plain = protobuf
    .parse('syntax="proto3"; message Plain { int32 n=1; }')
    .root.lookupType('Plain')
  let reads = 0
  const changing = Object.defineProperty({}, 'n', {
    get() {
      return ++reads
    }
  })
  plain.encode(changing).finish()
  const expectedReads = reads
  reads = 0
  wrap_gia(plain, changing)
  assert.equal(reads, expectedReads)
})

test('JSON file GIA path opts in; direct irToGia keeps default output and emits no partial file on failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsts-gia-memory-'))
  const originalNow = Date.now,
    originalRandom = Math.random
  Date.now = () => 1785715200000
  Math.random = () => 0.25
  // Client graph_body includes a process-local counter in its filePath. Freeze it as well
  // so consecutive old/new encodes receive identical inputs, without changing production IDs.
  Object.defineProperty(counter_dynamic_id, 'value', { configurable: true, get: () => 1 })
  try {
    const file = path.join(dir, 'input.json')
    const ir = document(1073742501)
    ir.graph.name = '_GSTS_low_memory_test'
    fs.writeFileSync(file, JSON.stringify(ir))
    const expected = irToGia(structuredClone(ir), { protoPath: DEFAULT_GIA_PROTO })
    assert.deepEqual(
      irToGia(structuredClone(ir), { protoPath: DEFAULT_GIA_PROTO, lowMemoryEncoding: true }),
      expected
    )
    const [output] = writeGiaFromIrJsonFile(file)
    assert.deepEqual(new Uint8Array(fs.readFileSync(output.giaPath)), expected)
    fs.writeFileSync(output.giaPath, 'sentinel')
    fs.writeFileSync(file, '{broken')
    assert.throws(() => writeGiaFromIrJsonFile(file), SyntaxError)
    assert.equal(fs.readFileSync(output.giaPath, 'utf8'), 'sentinel')

    const { rootMessage } = loadGiaProto()
    const originalEncode = rootMessage.encode
    let passes = 0
    rootMessage.encode = function (...args) {
      passes++
      return originalEncode.apply(this, args)
    }
    try {
      irToGia(structuredClone(ir), { protoPath: DEFAULT_GIA_PROTO })
      assert.equal(passes, 1, 'direct API keeps single-pass default')
      passes = 0
      fs.writeFileSync(file, JSON.stringify(ir))
      writeGiaFromIrJsonFile(file)
      assert.equal(passes, 2, 'JSON pipeline opts into low-memory encoding')
    } finally {
      rootMessage.encode = originalEncode
    }

    const clientTypes = {
      character_skill: 'node_graph_begins',
      character_control_skill: 'node_graph_begins',
      creation_skill: 'node_graph_begins',
      creation_status: 'node_graph_begins',
      creation_status_decision: 'node_graph_begins',
      bool_filter: 'node_graph_end_boolean',
      int_filter: 'node_graph_end_integer'
    }
    for (const [sub_type, type] of Object.entries(clientTypes)) {
      const client = {
        ir_version: 1,
        ir_type: 'node_graph',
        graph: { type: 'client', sub_type, name: `low_memory_${sub_type}` },
        nodes: [{ id: 1, type }]
      }
      const original = irToGia(structuredClone(client), { protoPath: DEFAULT_GIA_PROTO })
      const optimized = irToGia(structuredClone(client), {
        protoPath: DEFAULT_GIA_PROTO,
        lowMemoryEncoding: true
      })
      assert.deepEqual(optimized, original, sub_type)
      fs.writeFileSync(file, JSON.stringify(client))
      const [written] = writeGiaFromIrJsonFile(file)
      assert.deepEqual(new Uint8Array(fs.readFileSync(written.giaPath)), original, sub_type)
    }
  } finally {
    Date.now = originalNow
    Math.random = originalRandom
    delete counter_dynamic_id.value
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
