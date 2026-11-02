export default class BitBuilder {
  protected bits: number[] = [];
  protected data: number[] = [];

  // 8bit 溜まるごとに 1byte として確定させる
  protected fill(): void {
    while (this.bits.length >= 8) {
      this.push(this.bits.splice(0, 8).reduce((byte, bit) => byte * 2 + bit, 0));
    }
  }

  // 確定した 1byte を追加する (継承先で書き込むバイトを加工できるように分けている)
  protected push(byte: number): void {
    this.data.push(byte);
  }

  public writeBits(value: number, length: number): void {
    // 上位 bit から順に value の下位 length bit を書き込む
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push(Math.floor(value / (2 ** i)) % 2);
    }
    this.fill();
  }

  public writeBool(value: boolean): void {
    this.writeBits(value ? 1 : 0, 1);
  }

  public writeUEG(value: number): void {
    // 指数ゴロム符号: (value + 1) の bit 数 - 1 個の 0 に続けて (value + 1) を書く
    value += 1;
    let bits = 0;
    for (let v = value; v > 0; v = Math.floor(v / 2)) { bits++; }
    this.writeBits(0, bits - 1);
    this.writeBits(value, bits);
  }

  public writeSEG(value: number): void {
    this.writeUEG(value <= 0 ? -2 * value : 2 * value - 1);
  }

  public writeByte(value: number): void {
    this.writeBits(value, 8);
  }

  public writeByteAlign(fill: 0 | 1 = 0): void {
    while ((this.bits.length % 8) !== 0) {
      this.bits.push(fill);
    }
    this.fill();
  }

  public isByteAligned(): boolean {
    return (this.bits.length % 8) === 0;
  }

  public writeBytes(value: Iterable<number>): void {
    for (const byte of value) { this.writeByte(byte); }
  }

  public build(): Buffer {
    const values = [... this.data];

    // 8bit に満たない残りは 0 で埋めて 1byte にする
    if (this.bits.length > 0) {
      let datum = 0;
      for (let i = 0; i < 8; i++) {
        datum = datum * 2 + (this.bits[i] ?? 0);
      }
      values.push(datum);
    }

    return Buffer.from(values);
  }
}
