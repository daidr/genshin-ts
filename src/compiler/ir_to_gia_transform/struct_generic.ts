import type { Argument, IRDocument } from '../../runtime/IR.js'
import type { NodeId } from './types.js'

// Generic server nodes (custom variables, list nodes) can carry a map-defined structure type.
// The editor writes such a node with its generic id only, typed pins whose value names the
// structure id, a usingStruct entry on the node and a matching entry in the graph affiliations.
// Structure ids are map specific, so compiled graphs carry a placeholder id plus the structure
// name on a ClientExecNode pin; the injector binds them by name (see injector/struct_nodes.ts).
// The structure name comes from `asType('struct' | 'struct_list', MyStruct)` on the connection
// or from the assemble / split / modify structure nodes that the value flows through.

/** Server VarType of a structure / structure list value. */
const VAR_TYPE_STRUCT = 25
const VAR_TYPE_STRUCT_LIST = 26

const PIN_KIND_IN_PARAM = 3
const PIN_KIND_OUT_PARAM = 4
const PIN_KIND_STRUCT_NAME = 5

const VAR_CLASS_CONCRETE = 10000
const VAR_CLASS_STRUCT = 10001
const VAR_CLASS_ARRAY = 10002
const ITEM_CLASS_SERVER = 1
const SERVER_TYPE_KIND_STRUCT = 1

const ID_CLASS_SYSTEM_DEFINED = 10001
const ID_TYPE_BASIC_NODE = 20000
const ID_KIND_SYS_CALL = 22000

/** First placeholder structure id; real ids are large (1077936129+), so these never collide. */
export const STRUCT_ID_PLACEHOLDER_BASE = 1

type StructValueType = 'struct' | 'struct_list'

type StructPinSpec = {
  kind: number
  index: number
  /** 'variable': the custom variable's own type, a structure or a structure list */
  value: StructValueType | 'variable'
}

type StructGenericSpec = {
  genericId: number
  /** usingStruct typeXxx, observed per node */
  usingType: number
  /** graph affiliation type, observed per node */
  affiliationType: number
  /** indexOfConcrete per value type; custom variables index struct and struct list apart */
  indexOfConcrete: Record<StructValueType, number>
  pins: StructPinSpec[]
  /** input pins the struct variant does not have */
  dropInputs?: number[]
}

const ASSEMBLY_LIST_ITEMS = 100

// Structure types come right after the vendor concrete maps: custom variables (M0, 21 types)
// take struct at 21 and struct list at 22; list nodes (M5 / M7, 10 types) take 10.
const CUSTOM_VARIABLE_CONCRETE = { struct: 21, struct_list: 22 }
const LIST_CONCRETE = { struct: 10, struct_list: 10 }

// Constants taken from editor-saved graphs; they do not depend on the structure.
const STRUCT_GENERIC_SPECS: Record<string, StructGenericSpec> = {
  set_custom_variable: {
    genericId: 22,
    usingType: 175,
    affiliationType: 27,
    indexOfConcrete: CUSTOM_VARIABLE_CONCRETE,
    pins: [{ kind: PIN_KIND_IN_PARAM, index: 2, value: 'variable' }]
  },
  get_custom_variable: {
    genericId: 50,
    usingType: 175,
    affiliationType: 23,
    indexOfConcrete: CUSTOM_VARIABLE_CONCRETE,
    pins: [{ kind: PIN_KIND_OUT_PARAM, index: 0, value: 'variable' }]
  },
  get_corresponding_value_from_list: {
    genericId: 128,
    usingType: 10,
    affiliationType: 73,
    indexOfConcrete: LIST_CONCRETE,
    pins: [
      { kind: PIN_KIND_IN_PARAM, index: 0, value: 'struct_list' },
      { kind: PIN_KIND_OUT_PARAM, index: 0, value: 'struct' }
    ]
  },
  get_list_length: {
    genericId: 142,
    usingType: 10,
    affiliationType: 79,
    indexOfConcrete: LIST_CONCRETE,
    pins: [{ kind: PIN_KIND_IN_PARAM, index: 0, value: 'struct_list' }]
  },
  assembly_list: {
    genericId: 169,
    usingType: 10,
    affiliationType: 47,
    indexOfConcrete: LIST_CONCRETE,
    pins: [
      ...Array.from({ length: ASSEMBLY_LIST_ITEMS }, (_, i) => ({
        kind: PIN_KIND_IN_PARAM,
        index: i + 1,
        value: 'struct' as const
      })),
      { kind: PIN_KIND_OUT_PARAM, index: 0, value: 'struct_list' }
    ],
    dropInputs: [0]
  }
}

const STRUCT_NODE_TYPES = new Set(['assemble_structure', 'split_structure', 'modify_structure'])

const isStructType = (t: unknown): t is 'struct' | 'struct_list' =>
  t === 'struct' || t === 'struct_list'

export type StructGenericInfo = {
  /** IR node id -> structure name, for generic nodes typed with a structure */
  nodes: Map<NodeId, string>
  /** IR node id -> custom variable type, for structure-typed custom variable nodes */
  variableTypes: Map<NodeId, StructValueType>
  /** structure name -> placeholder structure id */
  placeholders: Map<string, number>
}

/**
 * Finds generic nodes typed with a structure and rewrites structure-typed connections to a
 * plain type so node id resolution and the vendor pin model can handle the rest of the node;
 * the structure pins are rewritten after encoding.
 */
export function prepareStructGenericNodes(ir: IRDocument): StructGenericInfo {
  const nodes = ir.nodes ?? []
  const parent = new Map<NodeId, NodeId>()
  const find = (id: NodeId): NodeId => {
    let root = id
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!
    parent.set(id, root)
    return root
  }
  const union = (a: NodeId, b: NodeId) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const typeById = new Map<NodeId, string>()
  const structTyped = new Set<NodeId>()
  // structure value types on each node's structure connections, either end
  const valueTypes = new Map<NodeId, Set<StructValueType>>()
  const addValueType = (id: NodeId, type: StructValueType) => {
    const set = valueTypes.get(id) ?? new Set<StructValueType>()
    set.add(type)
    valueTypes.set(id, set)
  }
  for (const node of nodes) {
    typeById.set(node.id, node.type)
    for (const arg of node.args ?? []) {
      if (arg?.type !== 'conn' || !isStructType(arg.value.type)) continue
      union(node.id, arg.value.node_id)
      structTyped.add(node.id)
      structTyped.add(arg.value.node_id)
      addValueType(node.id, arg.value.type)
      addValueType(arg.value.node_id, arg.value.type)
    }
  }

  const nameByRoot = new Map<NodeId, string>()
  const bindName = (id: NodeId, name: string) => {
    const root = find(id)
    const existing = nameByRoot.get(root)
    if (existing !== undefined && existing !== name) {
      throw new Error(`[error] structures "${existing}" and "${name}" flow into the same value`)
    }
    nameByRoot.set(root, name)
  }
  for (const node of nodes) {
    for (const arg of node.args ?? []) {
      if (arg?.type === 'conn' && isStructType(arg.value.type) && arg.value.struct) {
        bindName(node.id, arg.value.struct)
      }
    }
    if (!STRUCT_NODE_TYPES.has(node.type)) continue
    const nameArg = node.args?.[0]
    if (nameArg?.type !== 'str' || typeof nameArg.value !== 'string') continue
    bindName(node.id, nameArg.value)
  }

  const info: StructGenericInfo = {
    nodes: new Map(),
    variableTypes: new Map(),
    placeholders: new Map()
  }
  for (const id of structTyped) {
    const type = typeById.get(id)
    if (!type || STRUCT_NODE_TYPES.has(type)) continue
    if (!(type in STRUCT_GENERIC_SPECS)) {
      throw new Error(`[error] ${type} (id=${id}) does not support structure values`)
    }
    const name = nameByRoot.get(find(id))
    if (name === undefined) {
      throw new Error(
        `[error] cannot tell which structure ${type} (id=${id}) uses; ` +
          "name it with asType('struct_list', MyStruct) / asType('struct', MyStruct)"
      )
    }
    info.nodes.set(id, name)
    if (STRUCT_GENERIC_SPECS[type].pins.some((p) => p.value === 'variable')) {
      const types = [...(valueTypes.get(id) ?? [])]
      if (types.length !== 1) {
        throw new Error(
          `[error] ${type} (id=${id}) is used both as a structure and as a structure list`
        )
      }
      info.variableTypes.set(id, types[0])
    }
    if (!info.placeholders.has(name)) {
      info.placeholders.set(name, STRUCT_ID_PLACEHOLDER_BASE + info.placeholders.size)
    }
  }

  if (structTyped.size > 0) {
    for (const node of nodes) {
      if (!node.args?.some((a) => a?.type === 'conn' && isStructType(a.value.type))) continue
      node.args = node.args.map((arg): Argument => {
        if (arg?.type !== 'conn' || !isStructType(arg.value.type)) return arg
        const type = arg.value.type === 'struct' ? 'int' : 'int_list'
        return { type: 'conn', value: { ...arg.value, type } }
      })
    }
  }
  return info
}

/** True when the pin is a structure pin of a structure-typed generic node. */
export function isStructGenericInput(
  info: StructGenericInfo,
  nodeType: string,
  nodeId: NodeId,
  pinIndex: number
): boolean {
  if (!info.nodes.has(nodeId)) return false
  const spec = STRUCT_GENERIC_SPECS[nodeType]
  return !!spec?.pins.some((p) => p.kind === PIN_KIND_IN_PARAM && p.index === pinIndex)
}

type RawConnect = { fromId: NodeId; fromIndex: number }

type RawPin = {
  i1?: { kind?: number; index?: number }
  i2?: { kind?: number; index?: number }
  value?: unknown
  type?: number
  connects?: unknown[]
}

type RawNode = {
  nodeIndex: number
  genericId?: { nodeId?: number }
  concreteId?: unknown
  pins?: RawPin[]
  usingStruct?: unknown[]
}

type RawGraph = { nodes?: RawNode[]; affiliations?: unknown[] }

function structPinValue(value: StructValueType, indexOfConcrete: number, structId: number) {
  const item = { structId }
  if (value === 'struct') {
    return {
      class: VAR_CLASS_CONCRETE,
      alreadySetVal: true,
      bConcreteValue: {
        indexOfConcrete,
        value: {
          class: VAR_CLASS_STRUCT,
          itemType: {
            classBase: ITEM_CLASS_SERVER,
            type_server: { type: VAR_TYPE_STRUCT, kind: SERVER_TYPE_KIND_STRUCT, item }
          },
          bStruct: {}
        },
        structs: { class: 1, inner: { wrapper: { class: VAR_CLASS_STRUCT, item: { structId } } } }
      }
    }
  }
  return {
    class: VAR_CLASS_CONCRETE,
    alreadySetVal: true,
    bConcreteValue: {
      indexOfConcrete,
      value: {
        class: VAR_CLASS_ARRAY,
        itemType: {
          classBase: ITEM_CLASS_SERVER,
          type_server: { type: VAR_TYPE_STRUCT_LIST, kind: SERVER_TYPE_KIND_STRUCT, item }
        },
        bArray: {}
      },
      structs: { class: 1, inner: { wrapper: { class: VAR_CLASS_ARRAY } } }
    }
  }
}

function usingStructInfo(spec: StructGenericSpec, structId: number) {
  return {
    source: {
      class: ID_CLASS_SYSTEM_DEFINED,
      type: ID_TYPE_BASIC_NODE,
      kind: ID_KIND_SYS_CALL,
      id: spec.genericId
    },
    typeXxx: spec.usingType,
    alwaysOneXxxx: 1,
    structId: { structId }
  }
}

/** Rewrites the encoded structure-typed generic nodes into the editor's generic form. */
export function postprocessStructGenericNodes(
  graph: RawGraph | undefined,
  info: StructGenericInfo,
  nodeTypeById: Map<NodeId, string>,
  inputs: Map<NodeId, Map<number, RawConnect>>
) {
  if (!graph || info.nodes.size === 0) return
  const affiliations = new Map<string, unknown>()
  for (const node of graph.nodes ?? []) {
    const name = info.nodes.get(node.nodeIndex)
    if (name === undefined) continue
    const nodeType = nodeTypeById.get(node.nodeIndex)!
    const spec = STRUCT_GENERIC_SPECS[nodeType]
    const structId = info.placeholders.get(name)!
    if (node.genericId?.nodeId !== spec.genericId) {
      throw new Error(
        `[error] ${nodeType} (id=${node.nodeIndex}) resolved to generic node ` +
          `${node.genericId?.nodeId}, expected ${spec.genericId}`
      )
    }

    delete node.concreteId
    const replaced = new Set(spec.pins.map((p) => `${p.kind}:${p.index}`))
    for (const index of spec.dropInputs ?? []) replaced.add(`${PIN_KIND_IN_PARAM}:${index}`)
    const kept = (node.pins ?? []).filter(
      (pin) => !replaced.has(`${pin.i1?.kind ?? 0}:${pin.i1?.index ?? 0}`)
    )
    for (const pin of kept) {
      // the generic node has no concrete pin layout; pin indexes are the generic ones
      if (pin.i1) pin.i2 = { ...pin.i1 }
    }
    const nodeInputs = inputs.get(node.nodeIndex)
    const variableType = info.variableTypes.get(node.nodeIndex)
    const structPins: RawPin[] = spec.pins.map((p) => {
      const value = p.value === 'variable' ? variableType! : p.value
      const pin: RawPin = {
        i1: { kind: p.kind, index: p.index },
        i2: { kind: p.kind, index: p.index },
        value: structPinValue(value, spec.indexOfConcrete[value], structId),
        type: value === 'struct' ? VAR_TYPE_STRUCT : VAR_TYPE_STRUCT_LIST
      }
      const from = p.kind === PIN_KIND_IN_PARAM ? nodeInputs?.get(p.index) : undefined
      if (from) {
        pin.connects = [
          {
            id: from.fromId,
            connect: { kind: PIN_KIND_OUT_PARAM, index: from.fromIndex },
            connect2: { kind: PIN_KIND_OUT_PARAM, index: from.fromIndex }
          }
        ]
      }
      return pin
    })
    const namePin: RawPin = {
      i1: { kind: PIN_KIND_STRUCT_NAME, index: 0 },
      i2: { kind: PIN_KIND_STRUCT_NAME, index: 0 },
      value: { class: 5, alreadySetVal: true, bString: { val: name } },
      type: 6
    }
    node.pins = [...kept, ...structPins, namePin].sort(
      (a, b) => (a.i1?.kind ?? 0) - (b.i1?.kind ?? 0) || (a.i1?.index ?? 0) - (b.i1?.index ?? 0)
    )
    node.usingStruct = [usingStructInfo(spec, structId)]
    affiliations.set(`${spec.genericId}:${structId}`, {
      info: usingStructInfo(spec, structId),
      type: { type: spec.affiliationType }
    })
  }
  graph.affiliations = [...(graph.affiliations ?? []), ...affiliations.values()]
}
