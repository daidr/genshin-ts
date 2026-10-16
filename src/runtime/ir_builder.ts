import type { ExecutionFlow, IRBuildInput } from './execution_flow_types.js'
import { CLIENT_DEFAULT_GRAPH_ID, SERVER_DEFAULT_GRAPH_ID } from './graph_defaults.js'
import type {
  Argument,
  ConnectionArgument,
  IRDocument,
  NextConnection,
  ServerNode,
  ValueType
} from './IR.js'
import type { MetaCallRecord } from './meta_call_types.js'
import {
  bool,
  configId,
  customVariableSnapshot,
  dict,
  DictKeyType,
  DictValueType,
  entity,
  enumeration,
  faction,
  float,
  generic,
  guid,
  int,
  list,
  localVariable,
  prefabId,
  str,
  struct,
  value,
  ValueMetadata,
  vec3
} from './value.js'

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`).replace(/^_/, '')
}

function buildConnValueType(arg: value): {
  type: ValueType
  enum?: string
  dict?: { k: DictKeyType; v: DictValueType }
  struct?: string
} {
  if (arg instanceof bool) return { type: 'bool' }
  if (arg instanceof int) return { type: 'int' }
  if (arg instanceof float) return { type: 'float' }
  if (arg instanceof str) return { type: 'str' }
  if (arg instanceof vec3) return { type: 'vec3' }
  if (arg instanceof guid) return { type: 'guid' }
  if (arg instanceof entity) return { type: 'entity' }
  if (arg instanceof prefabId) return { type: 'prefab_id' }
  if (arg instanceof configId) return { type: 'config_id' }
  if (arg instanceof faction) return { type: 'faction' }
  if (arg instanceof struct) return { type: 'struct', struct: arg.structName }
  if (arg instanceof localVariable) return { type: 'local_variable' }
  if (arg instanceof customVariableSnapshot) return { type: 'custom_variable_snapshot' }
  if (arg instanceof enumeration) return { type: 'enum', enum: camelToSnake(arg.getClassName()) }

  if (arg instanceof list) {
    const t = `${arg.getConcreteType()}_list` as ValueType
    return { type: t, struct: arg.structName }
  }

  if (arg instanceof dict) {
    return {
      type: 'dict',
      dict: {
        k: arg.getKeyType() as DictKeyType,
        v: arg.getValueType() as DictValueType
      }
    }
  }

  if (arg instanceof generic) {
    const t = arg.getConcreteType()
    if (!t) {
      throw new Error(
        '[error] generic connection value has no concrete type (call asType()/asDict() first)'
      )
    }
    if (t !== 'dict') return { type: t }
    const k = arg.getDictKeyType()
    const v = arg.getDictValueType()
    if (!k || !v) {
      throw new Error(
        '[error] generic(dict) connection value missing dict key/value type (call asDict() first)'
      )
    }
    return { type: 'dict', dict: { k, v } }
  }

  throw new Error(
    `[error] unsupported connection value type: ${arg.constructor?.name ?? 'unknown'}`
  )
}

function buildConnectionArgument(meta: ValueMetadata, arg: value): ConnectionArgument | null {
  if (meta.kind !== 'pin') return null
  const { type, dict, enum: enumName, struct: structName } = buildConnValueType(arg)
  return {
    type: 'conn',
    value: {
      node_id: meta.record.id,
      index: meta.pinIndex,
      type,
      enum: enumName,
      dict,
      ...(structName ? { struct: structName } : {})
    }
  }
}

function buildArgument(record: MetaCallRecord, arg: value): Argument {
  const meta = arg.getMetadata()
  if (!meta)
    throw new Error(
      `Error in ${record.nodeType} - Value has no metadata: ${JSON.stringify(arg.toIRLiteral())}`
    )
  const conn = buildConnectionArgument(meta, arg)
  if (conn) return conn

  return arg.toIRLiteral()
}

type NodeBuilder = (
  record: MetaCallRecord,
  next?: NextConnection[],
  isClient?: boolean
) => ServerNode

const buildDefaultNode: NodeBuilder = (record, next) => {
  const node: ServerNode = {
    id: record.id,
    type: record.nodeType
  }
  const args = record.args.map((arg) => buildArgument(record, arg))
  if (args.length) node.args = args
  if (next?.length) node.next = next
  return node
}

const buildBreakLoopNode: NodeBuilder = (record) => {
  const node: ServerNode = {
    id: record.id,
    type: record.nodeType
  }

  const out: NextConnection[] = []
  // break_loop has no exec output; only connect to loop break input pins.
  // if (next?.length) out.push(...next)

  // Both server and client finite-loop nodes take the break signal on their
  // second InFlow pin (index 1), distinct from the normal entry pin (index 0).
  const breakTargetIndex = 1

  for (const arg of record.args) {
    const lit = arg.toIRLiteral()
    if (!lit) continue
    if (lit.type !== 'int' || typeof lit.value !== 'number') {
      throw new Error(`Error in break_loop - Invalid loop node id literal: ${JSON.stringify(lit)}`)
    }
    out.push({ node_id: lit.value, target_index: breakTargetIndex })
  }

  if (out.length) node.next = out
  return node
}

const NODE_BUILDERS: Record<string, NodeBuilder> = {
  break_loop: buildBreakLoopNode
}

function buildNodeFromRecord(
  record: MetaCallRecord,
  next: NextConnection[] | undefined,
  isClient: boolean
): ServerNode {
  const builder = NODE_BUILDERS[record.nodeType] ?? buildDefaultNode
  return builder(record, next, isClient)
}

function buildNodesFromFlow(
  flow: ExecutionFlow,
  isClient: boolean,
  skipEventNode: boolean
): ServerNode[] {
  const nodes: ServerNode[] = []

  const getNext = (id: number) => flow.edges[id]

  // client filter graphs have no begins node in real GIA samples; the start
  // event is a runtime-only anchor and must not be emitted (nor its edges)
  if (!skipEventNode) {
    nodes.push(buildNodeFromRecord(flow.eventNode, getNext(flow.eventNode.id), isClient))
  }

  flow.execNodes.forEach((execNode) => {
    nodes.push(buildNodeFromRecord(execNode, getNext(execNode.id), isClient))
  })

  flow.dataNodes.forEach((dataNode) => {
    nodes.push(buildNodeFromRecord(dataNode, undefined, isClient))
  })

  return nodes
}

export function buildIRDocument(input: IRBuildInput): IRDocument {
  const isClient = !!input.clientSubType
  const skipEventNode =
    input.clientSubType === 'bool_filter' || input.clientSubType === 'int_filter'
  const nodes = input.flows.flatMap((flow) => buildNodesFromFlow(flow, isClient, skipEventNode))

  if (input.clientSubType) {
    return {
      ir_version: 1,
      ir_type: 'node_graph',
      graph: {
        type: 'client',
        mode: input.clientMode ?? 'beyond',
        sub_type: input.clientSubType,
        evaluation_interval: input.clientEvaluationInterval,
        id: input.graphId ?? CLIENT_DEFAULT_GRAPH_ID,
        name: input.graphName
      },
      // 客户端节点图当前不支持节点图变量；保留这一行作为未来支持时的落点，但不要写入 client IR。
      // variables: input.variables,
      nodes
    }
  }

  return {
    ir_version: 1,
    ir_type: 'node_graph',
    graph: {
      type: 'server',
      mode: input.serverMode ?? 'beyond',
      sub_type: input.serverSubType ?? 'entity',
      id: input.graphId ?? SERVER_DEFAULT_GRAPH_ID,
      name: input.graphName
    },
    variables: input.variables,
    nodes
  }
}
