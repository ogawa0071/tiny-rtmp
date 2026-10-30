import BitBuilder from '../../03-tiny-http-ts-server/src/bit-builder.mts';

// NAL Unit の中身 (RBSP) を書き込みつつ、EBSP へのエスケープを行う
export default class EBSPBitBuilder extends BitBuilder {
  protected push(byte: number): void {
    // 0x000000 ~ 0x000003 は Start Code などと紛らわしいので、
    // 0x00 0x00 の後に 0x03 以下が続く場合は emulation_prevention_three_byte (0x03) を挟む
    if (this.data.at(-2) === 0 && this.data.at(-1) === 0 && byte <= 0x03) {
      this.data.push(0x03);
    }
    this.data.push(byte);
  }

  public writeRBSPTrailingBits(): void {
    this.writeBits(1, 1); // rbsp_stop_one_bit
    this.writeByteAlign(0); // rbsp_alignment_zero_bit
  }
}
