import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listGilFiles, resolveGilFolder, resolveGilTarget } from '../../src/cli/gil_paths.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsts-gil-paths-'))
const previousLocalAppData = process.env.LOCALAPPDATA
try {
  for (const gameRegion of ['China', 'Global'] as const) {
    const appData = path.join(tempDir, gameRegion, 'AppData')
    process.env.LOCALAPPDATA = path.join(appData, 'Local')
    const saveLevelDir = path.join(
      appData,
      'LocalLow',
      'miHoYo',
      gameRegion === 'China' ? '原神' : 'Genshin Impact',
      'BeyondLocal',
      '123',
      'Beyond_Local_Save_Level'
    )
    fs.mkdirSync(saveLevelDir, { recursive: true })
    assert.deepEqual(listGilFiles(saveLevelDir), [])
    assert.equal(resolveGilFolder({}).saveLevelDir, saveLevelDir)
    assert.throws(() => resolveGilTarget({}), /mapId is required/)
    assert.throws(
      () => resolveGilTarget({ mapId: 456 }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(path.join(saveLevelDir, '456', '456.gil')))
        assert.ok(error.message.includes(path.join(saveLevelDir, '456.gil')))
        return true
      }
    )

    const legacy = path.join(saveLevelDir, '456.gil')
    const nested = path.join(saveLevelDir, '456', '456.gil')
    fs.writeFileSync(legacy, 'legacy')
    assert.equal(resolveGilTarget({ mapId: 456 }).gilPath, legacy)
    fs.mkdirSync(path.dirname(nested))
    // An empty map directory must not hide its legacy save.
    assert.equal(resolveGilTarget({ mapId: 456 }).gilPath, legacy)
    fs.mkdirSync(nested)
    assert.equal(resolveGilTarget({ mapId: 456 }).gilPath, legacy)
    fs.rmdirSync(nested)
    fs.writeFileSync(nested, 'current')
    // The current layout wins even when the legacy file is newer.
    fs.utimesSync(nested, new Date(0), new Date(0))
    const target = resolveGilTarget({ mapId: 456 })
    assert.equal(target.gilPath, nested)
    assert.equal(target.region, gameRegion)
    assert.equal(target.playerId, 123)
    assert.equal(target.saveLevelDir, saveLevelDir)
    assert.deepEqual(listGilFiles(saveLevelDir), [nested])
    fs.unlinkSync(legacy)
    assert.equal(resolveGilTarget({ gameRegion, playerId: 123, mapId: 456 }).gilPath, nested)

    const otherLegacy = path.join(saveLevelDir, '789.GIL')
    fs.writeFileSync(otherLegacy, 'other legacy')
    fs.mkdirSync(path.join(saveLevelDir, '999'))
    fs.writeFileSync(path.join(saveLevelDir, '999', '888.gil'), 'wrong map')
    fs.mkdirSync(path.join(saveLevelDir, '456', 'external_lua_file'))
    fs.writeFileSync(path.join(saveLevelDir, '456', 'external_lua_file', 'extra.gil'), 'unrelated')
    assert.deepEqual(new Set(listGilFiles(saveLevelDir)), new Set([nested, otherLegacy]))
    assert.throws(() => resolveGilTarget({ mapId: 999 }), /target gil not found/)
  }
} finally {
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = previousLocalAppData
  fs.rmSync(tempDir, { recursive: true, force: true })
}

console.log('[ok] current and legacy map layouts, precedence, listing and region detection')
