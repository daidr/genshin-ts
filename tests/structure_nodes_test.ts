import { defineStruct, g } from 'genshin-ts/runtime/core'

// Mirrors the TestStruct sample map: assemble -> split, assemble -> modify.
const Struct = {
  TestStruct: defineStruct('TestStruct', [
    ['新增变量1-整数', 'int'],
    ['新增变量2-浮点数', 'float'],
    ['新增变量3-字符串', 'str'],
    ['新增变量4-实体', 'entity'],
    ['新增变量5-三维向量', 'vec3'],
    ['新增变量6-整数列表', 'int_list']
  ])
} as const

g.server({ id: 1073741889 }).on('whenEntityIsCreated', (_evt, f) => {
  const value = f.assembleStructure(Struct.TestStruct, {
    '新增变量1-整数': 1n,
    '新增变量2-浮点数': 2.2,
    '新增变量3-字符串': '这是字符串内容',
    '新增变量4-实体': f.getSelfEntity(),
    '新增变量5-三维向量': [5, 6, 7],
    '新增变量6-整数列表': f.assemblyList([1n, 2n], 'int')
  })
  const fields = f.splitStructure(Struct.TestStruct, value)
  f.printString(fields['新增变量3-字符串'])
  f.printString(f.dataTypeConversion(f.addition(fields['新增变量1-整数'], 1n), 'str'))
  f.modifyStructure(Struct.TestStruct, value, {
    '新增变量1-整数': 234n,
    '新增变量3-字符串': '568'
  })
})

// Structures in custom variables and list nodes; asType names the variable's structure.
g.server({ id: 1073741890 }).on('whenEntityIsCreated', (_evt, f) => {
  const saves = f
    .getCustomVariable(f.getSelfEntity(), 'saves')
    .asType('struct_list', Struct.TestStruct)
  if (f.getListLength(saves) > 0n) {
    const fields = f.splitStructure(Struct.TestStruct, f.getCorrespondingValueFromList(saves, 0n))
    f.printString(fields['新增变量3-字符串'])
  }
  const value = f.assembleStructure(Struct.TestStruct, { '新增变量3-字符串': 'saved' })
  f.setCustomVariable(f.getSelfEntity(), 'saves', f.assemblyList([value], 'struct'))

  // A single structure in a custom variable.
  const last = f.getCustomVariable(f.getSelfEntity(), 'last').asType('struct', Struct.TestStruct)
  f.printString(f.splitStructure(Struct.TestStruct, last)['新增变量3-字符串'])
  f.setCustomVariable(f.getSelfEntity(), 'last', value)

  // Only the list length is read: no structure node in sight, the structure comes from asType.
  const history = f
    .getCustomVariable(f.getSelfEntity(), 'history')
    .asType('struct_list', Struct.TestStruct)
  f.printString(f.dataTypeConversion(f.getListLength(history), 'str'))
})

// Client graphs only assemble / split.
g.creationSkill({ id: 1082130720, mode: 'beyond' }).on('start', (_evt, f) => {
  const value = f.assembleStructure(Struct.TestStruct, {
    '新增变量1-整数': 3n,
    '新增变量4-实体': f.getSelfEntity()
  })
  const fields = f.splitStructure(Struct.TestStruct, value)
  f.setTheCdOfTheCreationSkill(fields['新增变量1-整数'], fields['新增变量2-浮点数'], 1)
})

g.creationStatus({ id: 1082130721, mode: 'beyond' }).on('start1', (_evt, f) => {
  const fields = f.splitStructure(Struct.TestStruct, f.assembleStructure(Struct.TestStruct))
  f.executeSkill(f.equal(fields['新增变量1-整数'], 0n), fields['新增变量1-整数'])
})
