// バッファの offset 位置に値を書き込む処理
type Writer = (buffer: Buffer, offset: number) => void;

// 書き込んだ後から、途中の位置 (負数なら末尾からの位置) を書き換えられる可変長のバッファ
export default class ByteVector {
  private buffer: Buffer;
  private length = 0;

  public constructor(capacity?: number) {
    this.buffer = Buffer.alloc(capacity ?? 64);
  }

  public static from(buffer: Buffer): ByteVector {
    const vector = new ByteVector(buffer.byteLength);
    vector.write(buffer);
    return vector;
  }

  private extend(desired: number): void {
    let capacity = this.buffer.byteLength;
    while (capacity < desired) {
      capacity *= 2;
    }
    if (capacity !== this.buffer.byteLength) {
      const extended = Buffer.alloc(capacity);
      extended.set(this.buffer.subarray(0, this.length));
      this.buffer = extended;
    }
  }

  // 負数の位置は末尾からの位置として扱う
  private resolve(position: number): number {
    return position < 0 ? this.length + position : position;
  }

  // position (省略時は末尾) から byteLength バイトを書き込む (書き込めるのは今のデータの末尾まで)
  private writeAt(position: number | undefined, byteLength: number, write: Writer): void {
    const offset = this.resolve(position ?? this.length);
    if (offset < 0 || offset > this.length) {
      throw new RangeError('Attempt to access memory outside buffer bounds');
    }
    this.extend(offset + byteLength);
    write(this.buffer, offset);
    this.length = Math.max(this.length, offset + byteLength);
  }

  // position から byteLength バイト読み込める位置かを確認して、実際の位置を返す
  private readAt(position: number, byteLength: number): number {
    const offset = this.resolve(position);
    if (offset < 0 || offset + byteLength > this.length) {
      throw new RangeError('Attempt to access memory outside buffer bounds');
    }
    return offset;
  }

  public write(buffer: Buffer, position?: number): void {
    this.writeAt(position, buffer.byteLength, (dst, offset) => dst.set(buffer, offset));
  }

  public writeUIntBE(value: number, length: number, position?: number): void {
    this.writeAt(position, length, (dst, offset) => dst.writeUIntBE(value, offset, length));
  }

  public writeIntBE(value: number, length: number, position?: number): void {
    this.writeAt(position, length, (dst, offset) => dst.writeIntBE(value, offset, length));
  }

  public writeUIntLE(value: number, length: number, position?: number): void {
    this.writeAt(position, length, (dst, offset) => dst.writeUIntLE(value, offset, length));
  }

  public writeIntLE(value: number, length: number, position?: number): void {
    this.writeAt(position, length, (dst, offset) => dst.writeIntLE(value, offset, length));
  }

  public writeU8(value: number, position?: number): void {
    this.writeUIntBE(value, 1, position);
  }

  public writeU16BE(value: number, position?: number): void {
    this.writeUIntBE(value, 2, position);
  }

  public writeU24BE(value: number, position?: number): void {
    this.writeUIntBE(value, 3, position);
  }

  public writeU32BE(value: number, position?: number): void {
    this.writeUIntBE(value, 4, position);
  }

  public writeU16LE(value: number, position?: number): void {
    this.writeUIntLE(value, 2, position);
  }

  public writeU24LE(value: number, position?: number): void {
    this.writeUIntLE(value, 3, position);
  }

  public writeU32LE(value: number, position?: number): void {
    this.writeUIntLE(value, 4, position);
  }

  public writeI8(value: number, position?: number): void {
    this.writeIntBE(value, 1, position);
  }

  public writeI16BE(value: number, position?: number): void {
    this.writeIntBE(value, 2, position);
  }

  public writeI24BE(value: number, position?: number): void {
    this.writeIntBE(value, 3, position);
  }

  public writeI32BE(value: number, position?: number): void {
    this.writeIntBE(value, 4, position);
  }

  public writeI16LE(value: number, position?: number): void {
    this.writeIntLE(value, 2, position);
  }

  public writeI24LE(value: number, position?: number): void {
    this.writeIntLE(value, 3, position);
  }

  public writeI32LE(value: number, position?: number): void {
    this.writeIntLE(value, 4, position);
  }

  public writeF32BE(float: number, position?: number): void {
    this.writeAt(position, 4, (dst, offset) => dst.writeFloatBE(float, offset));
  }

  public writeF64BE(double: number, position?: number): void {
    this.writeAt(position, 8, (dst, offset) => dst.writeDoubleBE(double, offset));
  }

  public writeF32LE(float: number, position?: number): void {
    this.writeAt(position, 4, (dst, offset) => dst.writeFloatLE(float, offset));
  }

  public writeF64LE(double: number, position?: number): void {
    this.writeAt(position, 8, (dst, offset) => dst.writeDoubleLE(double, offset));
  }

  public build(): Buffer {
    return this.read();
  }

  public read(begin?: number, end?: number): Buffer {
    begin = this.resolve(begin ?? 0);
    end = this.resolve(end ?? this.length);
    if (begin < 0 || begin > end || end > this.length) {
      throw new RangeError('Attempt to access memory outside buffer bounds');
    }
    return Buffer.from(this.buffer.subarray(begin, end));
  }

  public readUIntBE(position: number, length: number): number {
    return this.buffer.readUIntBE(this.readAt(position, length), length);
  }

  public readIntBE(position: number, length: number): number {
    return this.buffer.readIntBE(this.readAt(position, length), length);
  }

  public readUIntLE(position: number, length: number): number {
    return this.buffer.readUIntLE(this.readAt(position, length), length);
  }

  public readIntLE(position: number, length: number): number {
    return this.buffer.readIntLE(this.readAt(position, length), length);
  }

  public readU8(position: number): number {
    return this.readUIntBE(position, 1);
  }

  public readU16BE(position: number): number {
    return this.readUIntBE(position, 2);
  }

  public readU24BE(position: number): number {
    return this.readUIntBE(position, 3);
  }

  public readU32BE(position: number): number {
    return this.readUIntBE(position, 4);
  }

  public readU16LE(position: number): number {
    return this.readUIntLE(position, 2);
  }

  public readU24LE(position: number): number {
    return this.readUIntLE(position, 3);
  }

  public readU32LE(position: number): number {
    return this.readUIntLE(position, 4);
  }

  public readI8(position: number): number {
    return this.readIntBE(position, 1);
  }

  public readI16BE(position: number): number {
    return this.readIntBE(position, 2);
  }

  public readI24BE(position: number): number {
    return this.readIntBE(position, 3);
  }

  public readI32BE(position: number): number {
    return this.readIntBE(position, 4);
  }

  public readI16LE(position: number): number {
    return this.readIntLE(position, 2);
  }

  public readI24LE(position: number): number {
    return this.readIntLE(position, 3);
  }

  public readI32LE(position: number): number {
    return this.readIntLE(position, 4);
  }

  public readF32BE(position: number): number {
    return this.buffer.readFloatBE(this.readAt(position, 4));
  }

  public readF64BE(position: number): number {
    return this.buffer.readDoubleBE(this.readAt(position, 8));
  }

  public readF32LE(position: number): number {
    return this.buffer.readFloatLE(this.readAt(position, 4));
  }

  public readF64LE(position: number): number {
    return this.buffer.readDoubleLE(this.readAt(position, 8));
  }

  public byteLength(): number {
    return this.length;
  }
}
