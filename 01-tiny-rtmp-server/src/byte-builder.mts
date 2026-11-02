// バッファの offset 位置に値を書き込む処理
type Writer = (buffer: Buffer, offset: number) => void;

export default class ByteBuilder {
  // 書き込み処理とそのバイト数を溜めておき、build() で一度だけ確保したバッファにまとめて書き込む
  private writers: { byteLength: number; write: Writer; }[] = [];
  private length = 0;

  private push(byteLength: number, write: Writer): void {
    this.writers.push({ byteLength, write });
    this.length += byteLength;
  }

  public write(buffer: Buffer): void {
    this.push(buffer.byteLength, (dst, offset) => dst.set(buffer, offset));
  }

  public writeUIntBE(value: number, length: number): void {
    this.push(length, (dst, offset) => dst.writeUIntBE(value, offset, length));
  }

  public writeIntBE(value: number, length: number): void {
    this.push(length, (dst, offset) => dst.writeIntBE(value, offset, length));
  }

  public writeUIntLE(value: number, length: number): void {
    this.push(length, (dst, offset) => dst.writeUIntLE(value, offset, length));
  }

  public writeIntLE(value: number, length: number): void {
    this.push(length, (dst, offset) => dst.writeIntLE(value, offset, length));
  }

  public writeU8(value: number) {
    this.writeUIntBE(value, 1);
  }

  public writeU16BE(value: number) {
    this.writeUIntBE(value, 2);
  }

  public writeU24BE(value: number) {
    this.writeUIntBE(value, 3);
  }

  public writeU32BE(value: number) {
    this.writeUIntBE(value, 4);
  }

  public writeU16LE(value: number) {
    this.writeUIntLE(value, 2);
  }

  public writeU24LE(value: number) {
    this.writeUIntLE(value, 3);
  }

  public writeU32LE(value: number) {
    this.writeUIntLE(value, 4);
  }

  public writeI8(value: number) {
    this.writeIntBE(value, 1);
  }

  public writeI16BE(value: number) {
    this.writeIntBE(value, 2);
  }

  public writeI24BE(value: number) {
    this.writeIntBE(value, 3);
  }

  public writeI32BE(value: number) {
    this.writeIntBE(value, 4);
  }

  public writeI16LE(value: number) {
    this.writeIntLE(value, 2);
  }

  public writeI24LE(value: number) {
    this.writeIntLE(value, 3);
  }

  public writeI32LE(value: number) {
    this.writeIntLE(value, 4);
  }

  public writeF32BE(float: number): void {
    this.push(4, (dst, offset) => dst.writeFloatBE(float, offset));
  }

  public writeF64BE(double: number): void {
    this.push(8, (dst, offset) => dst.writeDoubleBE(double, offset));
  }

  public writeF32LE(float: number): void {
    this.push(4, (dst, offset) => dst.writeFloatLE(float, offset));
  }

  public writeF64LE(double: number): void {
    this.push(8, (dst, offset) => dst.writeDoubleLE(double, offset));
  }

  public byteLength(): number {
    return this.length;
  }

  public build(): Buffer {
    const buffer = Buffer.alloc(this.length);

    let offset = 0;
    for (const { byteLength, write } of this.writers) {
      write(buffer, offset);
      offset += byteLength;
    }

    return buffer;
  }
}
