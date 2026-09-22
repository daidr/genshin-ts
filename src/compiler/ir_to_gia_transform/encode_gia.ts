import type protobuf from 'protobufjs'

import { encodeProtobufLowMemory } from '../../shared/protobuf_encode.js'
import type { Root as GiaRoot } from '../gia_vendor.js'

export { encodeProtobufLowMemory } from '../../shared/protobuf_encode.js'

/** @internal The public vendor wrap_gia keeps its original single-pass behavior. */
export function wrapGiaLowMemory(message: protobuf.Type, data: GiaRoot): ArrayBuffer {
  const bytes = encodeProtobufLowMemory(message, data)
  const buffer = new ArrayBuffer(bytes.byteLength + 24)
  const view = new DataView(buffer)
  const header = [bytes.byteLength + 20, 1, 0x0326, 3, bytes.byteLength]
  header.forEach((value, i) => view.setUint32(i * 4, value, false))
  new Uint8Array(buffer, 20, bytes.byteLength).set(bytes)
  view.setUint32(buffer.byteLength - 4, 0x0679, false)
  return buffer
}
