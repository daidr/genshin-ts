import { isClientNodeTypeAvailable } from '../../definitions/client_method_modes.js'
import type { ClientGraphMode, ClientGraphSubType } from '../../runtime/IR.js'
import { CLIENT_ERROR_CODES, clientNodegraphError } from '../../shared/client_capability_errors.js'
import { requireClientNodeMetadata } from '../../thirdparty/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack/node_data/client_helpers.js'
import type { ClientNodeMetadata } from '../../thirdparty/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack/node_data/client_node_metadata.js'
import {
  CLIENT_CUSTOM_VARIABLE_FAMILY_BY_SUB_TYPE,
  CLIENT_CUSTOM_VARIABLE_TYPE_OFFSET_BY_IR_TYPE
} from '../../thirdparty/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack/node_data/client_variable_specialization.js'
import type { IRNode } from './types.js'

const UNSUPPORTED_SPECIAL_KINDS = new Set(['structure_list_unknown_binding'])

/**
 * 字典反射节点：cid 恒定（1050..1055，见 varspec seed dictionaryNodes），
 * 键/值类型只体现在引脚 type/ioc 上，不参与 reflectMap 变体匹配。
 */
export const DICT_REFLECT_NODE_TYPES = new Set([
  'get_list_of_values_from_dictionary',
  'get_list_of_keys_from_dictionary',
  'query_dictionary_s_length',
  'query_dictionary_value_by_key',
  'query_if_dictionary_contains_specific_key',
  'query_if_dictionary_contains_specific_value'
])

/**
 * 字典构造节点：cid 恒定（拼装 1048 / 建立 1049），键值类型同样只体现在
 * 引脚 type/ioc 上；拼装节点 in#0 为 kv 参数总数，in#1..#100 键/值槽交替。
 */
export const DICT_BUILD_NODE_TYPES = new Set(['assembly_dictionary', 'create_dictionary'])

/**
 * 局部变量节点：cid 恒定（设置 2000 / 获取 1036，varspec seed localVariable），
 * 变量类型只体现在值引脚 type + ConcreteBase.ioc 上（类型序表见 client_graph.ts）。
 */
export const LOCAL_VARIABLE_NODE_TYPES = new Set(['get_local_variable', 'set_local_variable'])

/** IR value type -> ClientVarType id, mirroring the extractor's type name table */
export const CLIENT_VAR_TYPE_BY_IR_TYPE: Record<string, number> = {
  entity: 1,
  entity_list: 2,
  int: 3,
  int_list: 4,
  bool: 5,
  bool_list: 6,
  float: 7,
  float_list: 8,
  str: 9,
  str_list: 10,
  vec3: 11,
  vec3_list: 12,
  enum: 13,
  enumeration: 13,
  enum_list: 17,
  guid: 14,
  guid_list: 15,
  faction: 16,
  config_id: 18,
  prefab_id: 19,
  config_id_list: 20,
  prefab_id_list: 21,
  dict: 24,
  faction_list: 25
}

/** cid/ioc offset of a get_custom_variable output type */
export function customVariableTypeOffset(irType: string): number | undefined {
  return CLIENT_CUSTOM_VARIABLE_TYPE_OFFSET_BY_IR_TYPE[irType]
}

function assemblyListVariantKey(elementClientVarType: number): string {
  return Array.from({ length: 10 }, () => String(elementClientVarType)).join(',')
}

export type ClientReflectVariant = NonNullable<ClientNodeMetadata['reflectMap']>[number]

function irTypeOfArg(arg: NonNullable<IRNode['args']>[number] | undefined) {
  return arg == null ? undefined : arg.type === 'conn' ? arg.value.type : arg.type
}

function requireClientVarType(
  metadata: ClientNodeMetadata,
  irType: string | undefined,
  detail: string
) {
  const clientVarType = irType ? CLIENT_VAR_TYPE_BY_IR_TYPE[irType] : undefined
  if (clientVarType === undefined) {
    throw clientNodegraphError(
      CLIENT_ERROR_CODES.NODE_UNAVAILABLE,
      `${metadata.subType}.${metadata.nodeType} (genericId ${metadata.genericId}) ` +
        `cannot derive variant key: ${detail} has unresolvable type "${irType ?? 'missing'}"`
    )
  }
  return clientVarType
}

function matchReflectVariant(metadata: ClientNodeMetadata, key: string): ClientReflectVariant {
  const matches = metadata.reflectMap?.filter((variant) => variant.variantKey === key) ?? []
  if (matches.length !== 1) {
    const candidates = metadata.reflectMap?.map((variant) => variant.variantKey).join(' | ')
    throw clientNodegraphError(
      CLIENT_ERROR_CODES.NODE_UNAVAILABLE,
      `${metadata.subType}.${metadata.nodeType} (genericId ${metadata.genericId}) ` +
        `${matches.length === 0 ? 'has no' : 'has multiple'} reflect variants for key "${key}" ` +
        `(candidates: ${candidates || 'none confirmed'})`
    )
  }
  return matches[0]
}

/** Resolve the full static variant, including per-pin type and IOC data. */
export function resolveClientReflectVariant(
  metadata: ClientNodeMetadata,
  node: IRNode
): ClientReflectVariant | undefined {
  if (!metadata.reflectMap) return undefined
  if (
    metadata.nodeType === 'data_type_conversion' ||
    metadata.nodeType === 'get_custom_variable' ||
    metadata.nodeType === 'enumeration_match' ||
    DICT_REFLECT_NODE_TYPES.has(metadata.nodeType) ||
    DICT_BUILD_NODE_TYPES.has(metadata.nodeType) ||
    LOCAL_VARIABLE_NODE_TYPES.has(metadata.nodeType)
  ) {
    return undefined
  }

  if (metadata.nodeType === 'assembly_list') {
    const irType = irTypeOfArg(node.args?.[0])
    const clientVarType = requireClientVarType(metadata, irType, 'first list element')
    return matchReflectVariant(metadata, assemblyListVariantKey(clientVarType))
  }

  if (metadata.nodeType === 'multiple_branches') {
    const controlType = irTypeOfArg(node.args?.[0])
    const controlClientVarType = requireClientVarType(metadata, controlType, 'control value')
    const caseListClientVarType = requireClientVarType(
      metadata,
      controlType ? `${controlType}_list` : undefined,
      'case value list'
    )
    return matchReflectVariant(metadata, `${controlClientVarType},${caseListClientVarType}`)
  }

  const reflectiveIndexes = metadata.inputs
    .filter((pin) => pin.reflective)
    .map((pin) => pin.index)
    .sort((a, b) => a - b)
  const keyParts = reflectiveIndexes.map((index) => {
    const argIndex = metadata.argPins ? metadata.argPins.indexOf(index) : index
    const irType = irTypeOfArg(argIndex < 0 ? undefined : node.args?.[argIndex])
    return String(requireClientVarType(metadata, irType, `input pin #${index}`))
  })
  return matchReflectVariant(metadata, keyParts.join(','))
}

function getCustomVariableConcreteId(
  metadata: ClientNodeMetadata,
  outputIrType: string | undefined
): number | string {
  if (!outputIrType) {
    throw clientNodegraphError(
      CLIENT_ERROR_CODES.NODE_UNAVAILABLE,
      `${metadata.subType}.get_custom_variable cannot infer output type from connections`
    )
  }
  const family = CLIENT_CUSTOM_VARIABLE_FAMILY_BY_SUB_TYPE[metadata.subType]
  if (!family) {
    throw clientNodegraphError(
      CLIENT_ERROR_CODES.NODE_UNAVAILABLE,
      `${metadata.subType}.get_custom_variable has no cid table for this family`
    )
  }
  if (outputIrType === 'dict') {
    return family.dictCid
  }
  const offset = customVariableTypeOffset(outputIrType)
  if (offset === undefined) {
    throw clientNodegraphError(
      CLIENT_ERROR_CODES.NODE_UNAVAILABLE,
      `${metadata.subType}.get_custom_variable unknown output type "${outputIrType}"`
    )
  }
  return family.cidBase + offset
}

export function resolveClientNodeMetadata(
  subType: ClientGraphSubType,
  mode: ClientGraphMode,
  node: IRNode
): ClientNodeMetadata {
  // IR 与服务器同形：data_type_conversion_<out> 共享同一份 data_type_conversion 元数据
  const lookupType = node.type.startsWith('data_type_conversion_')
    ? 'data_type_conversion'
    : node.type
  const metadata = requireClientNodeMetadata(subType, lookupType)
  if (!isClientNodeTypeAvailable(subType, mode, metadata.nodeType)) {
    throw clientNodegraphError(
      CLIENT_ERROR_CODES.NODE_UNAVAILABLE,
      `${subType}.${node.type} is not available in ${mode} mode`
    )
  }
  if (metadata.specialKind && UNSUPPORTED_SPECIAL_KINDS.has(metadata.specialKind)) {
    throw clientNodegraphError(
      CLIENT_ERROR_CODES.UNSUPPORTED_SPECIAL_NODE,
      `${subType}.${node.type} uses unsupported special kind ${metadata.specialKind}`
    )
  }
  return metadata
}

/**
 * Deterministically resolve a node's concrete id.
 * get_custom_variable 的输出类型由输出连线推断（与服务器一致），经 customVarOutputIrType 传入。
 */
export function resolveClientConcreteVariant(
  metadata: ClientNodeMetadata,
  node: IRNode,
  customVarOutputIrType?: string
): number | string {
  if (metadata.nodeType === 'data_type_conversion') {
    return 130
  }
  // structure nodes share one system node per kind; the composite def is bound at injection
  if (metadata.nodeType === 'assemble_structure') return 1060
  if (metadata.nodeType === 'split_structure') return 1061
  if (metadata.nodeType === 'assembly_list') {
    return resolveClientReflectVariant(metadata, node)!.concreteId
  }
  if (metadata.nodeType === 'get_custom_variable') {
    return getCustomVariableConcreteId(metadata, customVarOutputIrType)
  }
  if (metadata.nodeType === 'enumeration_match') {
    if (metadata.concreteId == null) {
      throw clientNodegraphError(
        CLIENT_ERROR_CODES.NODE_UNAVAILABLE,
        `${metadata.subType}.${metadata.nodeType} has no constant concrete id in metadata`
      )
    }
    return metadata.concreteId
  }
  if (
    DICT_REFLECT_NODE_TYPES.has(metadata.nodeType) ||
    DICT_BUILD_NODE_TYPES.has(metadata.nodeType) ||
    LOCAL_VARIABLE_NODE_TYPES.has(metadata.nodeType)
  ) {
    if (metadata.concreteId == null) {
      throw clientNodegraphError(
        CLIENT_ERROR_CODES.NODE_UNAVAILABLE,
        `${metadata.subType}.${metadata.nodeType} has no constant concrete id in metadata`
      )
    }
    return metadata.concreteId
  }
  if (metadata.specialKind === 'inline_var_type_hint') {
    return metadata.concreteId ?? 2000
  }
  if (metadata.nodeType === 'send_signal_to_server_node_graph') {
    return metadata.concreteId ?? 2000
  }

  if (!metadata.reflectMap) {
    if (metadata.concreteId === null) {
      throw clientNodegraphError(
        CLIENT_ERROR_CODES.NODE_UNAVAILABLE,
        `${metadata.subType}.${metadata.nodeType} (genericId ${metadata.genericId}) has no concrete id`
      )
    }
    return metadata.concreteId
  }

  return resolveClientReflectVariant(metadata, node)!.concreteId
}
