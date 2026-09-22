import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import ts from 'typescript'

import { parseMessage, readUint32BE } from '../injector/binary.js'
import type { LenField, ParsedGilPayload } from '../injector/types.js'

export {
  decodeUtf8,
  readFieldBytes,
  readFieldMessages,
  readFieldVarint
} from '../injector/binary.js'

export type { ParsedGilPayload } from '../injector/types.js'

export type ExistingGeneratedFileCheck =
  | { status: 'skipped-existing'; outPath: string }
  | { status: 'failed'; outPath: string; error: string }

export type FormatWithPrettierResult = {
  attempted: boolean
  succeeded: boolean
  error?: string
}

function generatedSourcesEqual(left: string, right: string): boolean {
  function canonicalize(source: string): string | null {
    const sourceFile = ts.createSourceFile(
      'generated.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const parseDiagnostics = (
      sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
    ).parseDiagnostics
    if (parseDiagnostics?.length) return null
    function visit(node: ts.Node): unknown {
      if (ts.isPropertyAssignment(node)) {
        const name =
          ts.isIdentifier(node.name) ||
          ts.isStringLiteral(node.name) ||
          ts.isNumericLiteral(node.name)
            ? node.name.text
            : visit(node.name)
        return [node.kind, name, visit(node.initializer)]
      }
      let value: string | undefined
      if (
        ts.isIdentifier(node) ||
        ts.isStringLiteral(node) ||
        ts.isNumericLiteral(node) ||
        ts.isBigIntLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        value = node.text
      }
      const children: unknown[] = []
      node.forEachChild((child) => {
        children.push(visit(child))
      })
      return value === undefined ? [node.kind, children] : [node.kind, value, children]
    }

    const comments: string[] = []
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      source
    )
    while (true) {
      const kind = scanner.scan()
      if (kind === ts.SyntaxKind.EndOfFileToken) break
      if (
        kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        kind === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        comments.push(scanner.getTokenText().replace(/\s+/g, ' ').trim())
      }
    }
    return JSON.stringify([visit(sourceFile), comments])
  }
  const leftCanonical = canonicalize(left)
  return leftCanonical !== null && leftCanonical === canonicalize(right)
}

export function hasGeneratedHeader(text: string, header: string): boolean {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    return trimmed === header
  }
  return false
}

export function checkExistingGeneratedFile(
  outPath: string,
  header: string
): ExistingGeneratedFileCheck | null {
  if (!fs.existsSync(outPath)) return null
  try {
    const existing = fs.readFileSync(outPath, 'utf8')
    if (!hasGeneratedHeader(existing, header)) {
      return { status: 'skipped-existing', outPath }
    }
    return null
  } catch (e) {
    return {
      status: 'failed',
      outPath,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export function parseGilPayloadFields(bytes: Uint8Array): ParsedGilPayload {
  if (bytes.length < 24) {
    throw new Error('[error] invalid gil size')
  }
  const headTag = readUint32BE(bytes, 8)
  const tailTag = readUint32BE(bytes, bytes.length - 4)
  if (headTag !== 0x0326 || tailTag !== 0x0679) {
    throw new Error('[error] invalid gil header tags')
  }

  const payload = bytes.subarray(20, bytes.length - 4)
  const fields: LenField[] = []
  parseMessage(payload, 0, payload.length, 0, 0, 0, 0, 0, 0, 0, fields)
  return { payload, fields }
}

export function readGilPayloadFields(gilPath: string): ParsedGilPayload {
  return parseGilPayloadFields(fs.readFileSync(gilPath))
}

export function tryFormatWithPrettier(filePaths: string | string[]): FormatWithPrettierResult {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths]
  if (paths.length === 0) return { attempted: false, succeeded: false }

  let prettierBin: string | undefined
  try {
    const require = createRequire(import.meta.url)
    try {
      prettierBin = require.resolve('prettier/bin-prettier.cjs')
    } catch {
      try {
        prettierBin = require.resolve('prettier/bin/prettier.cjs')
      } catch {
        return {
          attempted: false,
          succeeded: false,
          error: 'Prettier executable not found'
        }
      }
    }
    const res = spawnSync(process.execPath, [prettierBin, '--write', ...paths], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (res.error || res.status !== 0) {
      return {
        attempted: true,
        succeeded: false,
        error:
          res.error?.message ||
          res.stderr.trim() ||
          (res.signal
            ? `Prettier terminated by signal ${res.signal}`
            : `Prettier exited with code ${String(res.status)}`)
      }
    }
    return { attempted: true, succeeded: true }
  } catch (error) {
    return {
      attempted: !!prettierBin,
      succeeded: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function writeGeneratedFile(
  outPath: string,
  source: string,
  options?: { format?: boolean }
) {
  if (fs.existsSync(outPath)) {
    const existing = fs.readFileSync(outPath, 'utf8')
    if (generatedSourcesEqual(existing, source)) return { changed: false }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, source)
  if (options?.format !== false) tryFormatWithPrettier(outPath)
  return { changed: true }
}
