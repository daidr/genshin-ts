import type protobuf from 'protobufjs'

import { decodeUtf8, readFieldBytes, readFieldMessages, readFieldVarint } from './binary.js'

// Structure nodes (assemble / split / modify) are composite nodes the editor generates per
// structure and per graph family when the structure is created (.gil field 10.2, kinds
// 1003-1005, keyed by structure id). Compiled graphs carry placeholder node ids plus the
// structure name on a ClientExecNode pin; injection swaps in the map's node definition.

type NodeIdInfo = {
  class?: number
  type?: number
  kind?: number
  nodeId?: number
}

type PinIndex = { kind?: number; index?: number }

type PatchPin = {
  i1?: PinIndex
  i2?: PinIndex
  value?: Record<string, unknown> | null
  compositePinIndex?: number
}

export type StructPatchGraph = {
  nodes?: Array<{
    genericId?: NodeIdInfo
    concreteId?: NodeIdInfo
    pins?: PatchPin[]
    usingStruct?: unknown[]
  }>
  affiliations?: unknown[]
}

type StructNodeKind = 'assemble' | 'split' | 'modify'

type StructDefPin = { kind: number; index: number; pinIndex: number }

type StructNodeDef = {
  genericId: NodeIdInfo
  concreteId: NodeIdInfo
  pins: StructDefPin[]
}

export type StructNodeIdMap = {
  structIds: Map<string, number>
  /** key: `${structId}:${kind}:${family}` */
  defs: Map<string, StructNodeDef>
}

type CompositeDefObject = {
  id?: { genericId?: unknown; concreteId?: unknown }
  type?: Partial<Record<StructNodeKind, { id?: number }>>
  inputs?: unknown
  outputs?: unknown
}

type ClientTypeObject = { marker?: { structId?: number } }

type TFunc = (key: string, options?: Record<string, unknown>) => string

const SERVER_FAMILY = 20000
const PIN_KIND_IN_PARAM = 3
const PIN_KIND_OUT_PARAM = 4
const PIN_KIND_STRUCT_NAME = 5

const DEF_KIND_BY_CODE = new Map<number, StructNodeKind>([
  [1003, 'assemble'],
  [1004, 'split'],
  [1005, 'modify']
])

const SERVER_PLACEHOLDERS = new Map<number, StructNodeKind>([
  [300002, 'assemble'],
  [300003, 'split'],
  [300004, 'modify']
])

// client placeholders are the editor's generic ids of the unbound structure nodes
const CLIENT_PLACEHOLDERS = new Map<number, StructNodeKind>([
  [200160, 'assemble'],
  [200161, 'split'],
  [200236, 'assemble'],
  [200237, 'split']
])

function placeholderKind(node: { genericId?: NodeIdInfo }): StructNodeKind | undefined {
  const id = node.genericId
  if (typeof id?.nodeId !== 'number') return undefined
  if (id.type === SERVER_FAMILY) return SERVER_PLACEHOLDERS.get(id.nodeId)
  return CLIENT_PLACEHOLDERS.get(id.nodeId)
}

function structNameOf(node: { pins?: PatchPin[] }): string | undefined {
  for (const pin of node.pins ?? []) {
    if (pin?.i1?.kind !== PIN_KIND_STRUCT_NAME) continue
    const s = (pin.value?.bString as { val?: unknown } | undefined)?.val
    if (typeof s === 'string') return s
  }
  return undefined
}

export function hasStructNodePlaceholders(graph: StructPatchGraph): boolean {
  return (graph.nodes ?? []).some(
    (node) => placeholderKind(node) !== undefined || isStructTypedGenericNode(node)
  )
}

// Generic nodes typed with a structure (custom variables, list nodes) carry a usingStruct entry,
// a placeholder structure id and the structure name on a ClientExecNode pin.
function isStructTypedGenericNode(node: { pins?: PatchPin[]; usingStruct?: unknown[] }): boolean {
  return !!node.usingStruct?.length && structNameOf(node) !== undefined
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber()
  }
  return undefined
}

/** Replaces every structId field whose value is a known placeholder. */
function replaceStructIds(obj: unknown, ids: Map<number, number>, seen = new Set<object>()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return
  seen.add(obj)
  const rec = obj as Record<string, unknown>
  for (const key of Object.keys(rec)) {
    const v = rec[key]
    if (key === 'structId') {
      const n = toNumber(v)
      if (n !== undefined && ids.has(n)) {
        rec[key] = ids.get(n)
        continue
      }
    }
    if (v && typeof v === 'object') replaceStructIds(v, ids, seen)
  }
}

function patchStructTypedGenericNodes(graph: StructPatchGraph, map: StructNodeIdMap, t?: TFunc) {
  const ids = new Map<number, number>()
  const nodes = (graph.nodes ?? []).filter(isStructTypedGenericNode)
  for (const node of nodes) {
    const name = structNameOf(node)!
    const structId = map.structIds.get(name)
    if (structId === undefined) {
      throw new Error(
        t
          ? t('injector_structMissing', { struct: name })
          : `[error] structure "${name}" is not defined; injection failed`
      )
    }
    const info = node.usingStruct![0] as { structId?: { structId?: unknown } }
    const placeholder = toNumber(info?.structId?.structId)
    if (placeholder === undefined) {
      throw new Error(`[error] structure "${name}" node has no placeholder structure id`)
    }
    const bound = ids.get(placeholder)
    if (bound !== undefined && bound !== structId) {
      throw new Error(`[error] structure placeholder ${placeholder} bound to two structures`)
    }
    ids.set(placeholder, structId)
    node.pins = (node.pins ?? []).filter((pin) => pin?.i1?.kind !== PIN_KIND_STRUCT_NAME)
  }
  if (ids.size === 0) return
  for (const node of nodes) replaceStructIds(node, ids)
  for (const entry of graph.affiliations ?? []) replaceStructIds(entry, ids)
}

function toNodeIdInfo(raw: unknown): NodeIdInfo {
  const id = (raw ?? {}) as Record<string, unknown>
  return {
    class: Number(id.class ?? 0),
    type: Number(id.type ?? 0),
    kind: Number(id.kind ?? 0),
    nodeId: Number(id.id ?? 0)
  }
}

function toDefPins(raw: unknown): StructDefPin[] {
  const out: StructDefPin[] = []
  for (const p of (raw ?? []) as Array<Record<string, unknown>>) {
    const index = p.index as { kind?: number; index?: number } | undefined
    // the hidden modify target has no index and never appears on graph nodes
    if (!index?.kind) continue
    out.push({ kind: index.kind, index: index.index ?? 0, pinIndex: Number(p.pinIndex ?? 0) })
  }
  return out
}

export function buildStructNodeIdMap(payload: Uint8Array, root: protobuf.Root): StructNodeIdMap {
  const structIds = new Map<string, number>()
  const defs = new Map<string, StructNodeDef>()
  const section = readFieldBytes(payload, 10)
  if (!section) return { structIds, defs }

  for (const entry of readFieldMessages(section, 6)) {
    const field = readFieldBytes(entry, 1)
    if (!field) continue
    const id = readFieldVarint(field, 1)
    const nameBytes = readFieldBytes(field, 501)
    const name = nameBytes ? decodeUtf8(nameBytes) : undefined
    if (id === undefined || name === undefined) continue
    structIds.set(name, id)
  }
  if (structIds.size === 0) return { structIds, defs }

  const compositeDef = root.lookupType('CompositeDef')
  for (const entry of readFieldMessages(section, 2)) {
    const bytes = readFieldBytes(entry, 1)
    if (!bytes) continue
    const typeBytes = readFieldBytes(bytes, 107)
    const kindCode = typeBytes ? readFieldVarint(typeBytes, 1) : undefined
    const kind = kindCode === undefined ? undefined : DEF_KIND_BY_CODE.get(kindCode)
    if (!kind) continue
    const def = compositeDef.toObject(compositeDef.decode(bytes), {
      longs: Number,
      enums: Number
    }) as CompositeDefObject
    const typeRef = def.type?.assemble ?? def.type?.split ?? def.type?.modify
    const structId = Number(typeRef?.id)
    const genericId = toNodeIdInfo(def.id?.genericId)
    const concreteId = toNodeIdInfo(def.id?.concreteId)
    if (!structId || !genericId.nodeId) continue
    const pins = [...toDefPins(def.inputs), ...toDefPins(def.outputs)]
    defs.set(`${structId}:${kind}:${genericId.type}`, { genericId, concreteId, pins })
  }
  return { structIds, defs }
}

function setStructMarker(value: Record<string, unknown> | null | undefined, structId: number) {
  // the injector decodes with keepCase, so the proto field name is type_client
  const itemType = value?.itemType as
    | { type_client?: ClientTypeObject; typeClient?: ClientTypeObject }
    | undefined
  const typeClient = itemType?.type_client ?? itemType?.typeClient
  if (typeClient?.marker) typeClient.marker.structId = structId
}

export function patchStructNodeIdsFromMap(
  graph: StructPatchGraph,
  map: StructNodeIdMap,
  t?: TFunc
) {
  patchStructTypedGenericNodes(graph, map, t)
  for (const node of graph.nodes ?? []) {
    const kind = placeholderKind(node)
    if (!kind) continue
    const name = structNameOf(node)
    const structId = name === undefined ? undefined : map.structIds.get(name)
    if (structId === undefined) {
      throw new Error(
        t
          ? t('injector_structMissing', { struct: name ?? 'unknown' })
          : `[error] structure "${name ?? 'unknown'}" is not defined; injection failed`
      )
    }
    const family = node.genericId!.type!
    const def = map.defs.get(`${structId}:${kind}:${family}`)
    if (!def) {
      throw new Error(
        t
          ? t('injector_structNodeMissing', { struct: name, kind, family })
          : `[error] structure "${name}" has no ${kind} node for graph family ${family}; injection failed`
      )
    }

    node.genericId = { ...def.genericId }
    node.concreteId = { ...def.concreteId }
    node.pins = (node.pins ?? []).filter((pin) => pin?.i1?.kind !== PIN_KIND_STRUCT_NAME)
    for (const pin of node.pins) {
      const at = pin.i2 ?? pin.i1
      const kindOfPin = at?.kind
      if (kindOfPin !== PIN_KIND_IN_PARAM && kindOfPin !== PIN_KIND_OUT_PARAM) continue
      const defPin = def.pins.find((p) => p.kind === kindOfPin && p.index === (at?.index ?? 0))
      if (!defPin) {
        throw new Error(
          `[error] structure "${name}" ${kind} node has no pin ${kindOfPin}:${at?.index ?? 0}; ` +
            'the structure definition may have changed, recompile the graph'
        )
      }
      pin.compositePinIndex = defPin.pinIndex
      setStructMarker(pin.value, structId)
    }
  }
}
