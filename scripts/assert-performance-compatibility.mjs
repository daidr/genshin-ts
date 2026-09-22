import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ts from 'typescript'

import { transformToGs } from '../dist/src/compiler/ts_to_gs_transform/index.js'
import { matchTypes, parseValue } from '../dist/src/definitions/nodes.js'
import { initCliI18n } from '../dist/src/i18n/index.js'
import { list, vec3 } from '../dist/src/runtime/value.js'

initCliI18n('en-US')

for (const input of [
  new Array(3),
  [1, , 3],
  [1, 2, undefined],
  [1, 2, NaN],
  [1, 2, Infinity],
  [1, 2, '3']
]) {
  assert.throws(() => parseValue(input, 'vec3'), /Invalid value type/)
  assert.throws(() => matchTypes(['vec3'], input))
  const wrapped = new list('float')
  wrapped.setVec3Value(input)
  assert.throws(() => parseValue(wrapped, 'vec3'), /Invalid vec3 value/)
}

for (const wrap of [false, true]) {
  const input = [1, 2, 3]
  const wrapped = new list('float')
  wrapped.setVec3Value(input)
  const saved = parseValue(wrap ? wrapped : input, 'vec3')
  input[0] = 99
  assert.deepEqual(saved.toIRLiteral(), { type: 'vec3', value: [1, 2, 3] })
}
const existing = new vec3([1, 2, 3])
assert.equal(parseValue(existing, 'vec3'), existing)
assert.equal(matchTypes(['vec3', 'str'], [1, 2, 3]), 'vec3')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsts-import-alias-'))
try {
  const cases = [
    { name: 'gstsServerExample', error: /gstsServer call is only allowed/ },
    { name: 'gstsClientCharacterSkillExample', error: /same client graph family/ },
    { name: 'ordinaryHelper', error: null }
  ]
  for (const { name, error } of cases) {
    const helper = path.join(tempDir, `${name}.ts`)
    fs.writeFileSync(
      helper,
      `export function ${name}() { return 1n }\nexport { ${name} as default, ${name} as action }\n`
    )
    const barrel = path.join(tempDir, 'barrel.ts')
    fs.writeFileSync(barrel, `export * as tools from './${name}.js'\n`)
    for (const [kind, importClause] of [
      ['default', 'action'],
      ['named', `{ ${name} as action }`],
      ['namespace', '* as helpers'],
      ['nested-namespace', '* as helpers']
    ]) {
      const entry = path.join(tempDir, `${name}-${kind}.ts`)
      const nested = kind === 'nested-namespace'
      const callee = nested
        ? 'helpers.tools.action'
        : kind === 'namespace'
          ? `helpers.${name}`
          : 'action'
      fs.writeFileSync(
        entry,
        `import ${importClause} from './${nested ? 'barrel' : name}.js'\n${callee}()\n`
      )
      const program = ts.createProgram([helper, entry], {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler
      })
      const source = program.getSourceFile(entry)
      assert.ok(source)
      const transform = () =>
        transformToGs(source, {
          checker: program.getTypeChecker(),
          config: {},
          timerCounterRef: { value: 0 }
        })
      if (error) assert.throws(transform, error)
      else assert.doesNotThrow(transform)
    }
  }
  console.log(
    '[ok] default/named/nested namespace aliases and vec3 validation/snapshot compatibility'
  )
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
