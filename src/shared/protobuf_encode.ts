import protobuf from 'protobufjs'

function uint32Size(value: number) {
  return value < 128 ? 1 : value < 16384 ? 2 : value < 2097152 ? 3 : value < 268435456 ? 4 : 5
}

// Keep protobufjs's scalar encoders, but replace its per-scalar Op/VarintOp list.
// Pass one retains only nested message lengths; pass two writes directly into a Buffer.
// Only for stable compiler-owned or protobuf-decoded data, not a general Writer replacement.
class TwoPassWriter extends protobuf.BufferWriter {
  private readonly parents: number[] = []
  private readonly indices: number[] = []
  cursor = 0

  constructor(
    readonly lengths: number[],
    private readonly buffer?: Buffer
  ) {
    super()
  }

  _push<T>(fn: (value: T, buffer: Uint8Array, pos: number) => void, len: number, value: T) {
    if (this.buffer) fn(value, this.buffer, this.len)
    this.len += len
    return this
  }

  override uint32(value: number) {
    value >>>= 0
    if (this.buffer) {
      while (value > 127) {
        this.buffer[this.len++] = (value & 127) | 128
        value >>>= 7
      }
      this.buffer[this.len++] = value
    } else {
      this.len += uint32Size(value)
    }
    return this
  }

  override fork() {
    if (this.buffer) {
      this.uint32(this.lengths[this.cursor++])
    } else {
      this.indices.push(this.lengths.length)
      this.lengths.push(0)
      this.parents.push(this.len)
      this.len = 0
    }
    return this
  }

  override ldelim() {
    if (!this.buffer) {
      if (!this.parents.length) throw new Error('Unpaired protobuf length delimiter')
      const len = this.len
      this.lengths[this.indices.pop()!] = len
      this.len = this.parents.pop()! + uint32Size(len) + len
    }
    return this
  }

  override reset(): this {
    throw new Error('Two-pass protobuf encoding does not support reset')
  }
}

/** @internal Only encode stable plain data: both passes traverse the same field values. */
export function encodeProtobufLowMemory(message: protobuf.Type, data: object): Uint8Array {
  const lengths: number[] = []
  const size = new TwoPassWriter(lengths)
  message.encode(data, size)
  const buffer = Buffer.allocUnsafe(size.len)
  const writer = new TwoPassWriter(lengths, buffer)
  message.encode(data, writer)
  if (writer.len !== buffer.length || writer.cursor !== lengths.length) {
    throw new Error('Two-pass protobuf encoding length mismatch')
  }
  return buffer
}
