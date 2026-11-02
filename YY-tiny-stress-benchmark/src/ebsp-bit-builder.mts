import BitBuilder from '../../03-tiny-http-ts-server/src/bit-builder.mts';

export default class EBSPBitBuilder extends BitBuilder {
  protected push(byte: number): void {
    if (this.data.at(-2) === 0 && this.data.at(-1) === 0 && byte <= 0x03) {
      this.data.push(0x03);
    }
    this.data.push(byte);
  }

  public writeRBSPTrailingBits(): void {
    this.writeBits(1, 1);
    this.writeByteAlign(0);
  }
}
