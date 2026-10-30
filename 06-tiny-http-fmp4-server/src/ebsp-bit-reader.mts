import BitReader from '../../03-tiny-http-ts-server/src/bit-reader.mts';

// emulation_prevention_three_byte として取り除いたバイトの印
const unescaped = Symbol();

// NAL Unit の中身 (EBSP) から emulation_prevention_three_byte を取り除きながら (RBSP として) 読む
// 0x00 0x00 0x03 の 0x03 が取り除く対象なので、次に読むバイトを 2 つ先まで覗き見ながら読み進める
export default class EBSPBitReader extends BitReader {
  private fst_byte: number | null | typeof unescaped = null; // 次に読むバイト
  private snd_byte: number | null | typeof unescaped = null; // その次に読むバイト

  public isEOF(): boolean {
    return this.reader.isEOF() && this.fst_byte == null && this.snd_byte == null && this.bits_offset >= 8;
  }

  protected fill(): void {
    let byte: number | null | typeof unescaped = !this.reader.isEOF() ? this.reader.readU8() : null;

    // unescape ebsp to rbsp
    if (this.fst_byte === 0 && this.snd_byte === 0 && byte === 3) {
      byte = unescaped;
    }

    if (typeof this.fst_byte === 'number') {
      this.bits = this.fst_byte;
      this.bits_offset = 0;
    } else if (this.fst_byte === unescaped) {
      // 取り除いたバイトも、EBSP として何 bit 読んだかには含める
      this.consumed += 8;
    }

    this.fst_byte = this.snd_byte;
    this.snd_byte = byte;
  }
}
