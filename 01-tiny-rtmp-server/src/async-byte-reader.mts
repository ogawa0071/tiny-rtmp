export type AsyncByteReaderOption = Partial<{
  signal: AbortSignal;
  highWaterMark: number;
}>;

type PendingRead = PromiseWithResolvers<Buffer> & {
  byteLength: number;
};

export default class AsyncByteReader {
  private buffers: Buffer[] = [];
  private offset = 0; // buffers[0] のうち読み取り済みのバイト数
  private totals = 0; // buffers に溜まっている未読のバイト数
  private reserved = 0; // 待機中の read で要求されているバイト数の合計
  private eof = false;
  private pendings: PendingRead[] = [];
  private controller = new AbortController();
  private signal: AbortSignal;
  private highWaterMark: number;

  public constructor(option?: AsyncByteReaderOption) {
    this.signal = AbortSignal.any([this.controller.signal, option?.signal].filter((signal) => signal != null));
    this.highWaterMark = option?.highWaterMark ?? Number.POSITIVE_INFINITY;
    // 既に中断済みの signal が渡された場合は abort イベントが来ないので、ここで EOF にする
    if (this.signal.aborted) {
      this.reachEOF();
    } else {
      this.signal.addEventListener('abort', () => { this.reachEOF(); }, { once: true });
    }
  }

  // buffers の先頭から length バイトを切り出す (呼び出し側で totals >= length を保証する)
  private take(length: number): Buffer {
    const chunks: Buffer[] = [];
    let remains = length;
    while (remains > 0) {
      const buffer = this.buffers[0];
      const available = buffer.byteLength - this.offset;

      if (available > remains) {
        chunks.push(buffer.subarray(this.offset, this.offset + remains));
        this.offset += remains;
        break;
      }

      chunks.push(buffer.subarray(this.offset));
      this.buffers.shift();
      this.offset = 0;
      remains -= available;
    }

    this.totals -= length;
    this.reserved -= length;
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  }

  private fulfill(): void {
    // 要求された順に、必要なバイト数が溜まっている read を解決する
    while (this.pendings.length > 0 && this.pendings[0].byteLength <= this.totals) {
      const { byteLength, resolve } = this.pendings.shift()!;
      resolve(this.take(byteLength));
    }

    // EOF ならこれ以上データは来ないので、満たせなかった read は全て失敗させる
    if (!this.eof) { return; }
    for (const { reject } of this.pendings.splice(0)) {
      reject(this.signal.reason);
    }
  }

  private reachEOF(): void {
    this.eof = true;
    this.fulfill();
  }

  public feed(buffer: Buffer): void {
    if (this.eof) { return; }
    // 誰にも要求されていないデータが highWaterMark を超えて溜まっていたら、溢れたとして終了する
    if (this.highWaterMark < this.totals - this.reserved) {
      this.feedEOF(new Error('Buffer overflow: highWaterMark exceeded'));
      return;
    }
    this.buffers.push(buffer);
    this.totals += buffer.byteLength;
    this.fulfill();
  }

  public feedEOF(reason: unknown = new Error('EOF Detected')): void {
    this.controller.abort(reason);
  }

  public [Symbol.dispose](): void {
    this.feedEOF();
  }

  public read(size: number): Promise<Buffer> {
    if (this.eof && (this.reserved + Math.max(1, size)) > this.totals) {
      return Promise.reject(this.signal.reason);
    }

    const pending = { byteLength: size, ... Promise.withResolvers<Buffer>() };
    this.reserved += size;
    this.pendings.push(pending);
    this.fulfill();
    return pending.promise;
  }

  public async readUIntBE(length: number): Promise<number> {
    return (await this.read(length)).readUIntBE(0, length);
  }

  public async readUIntLE(length: number): Promise<number> {
    return (await this.read(length)).readUIntLE(0, length);
  }

  public async readIntBE(length: number): Promise<number> {
    return (await this.read(length)).readIntBE(0, length);
  }

  public async readIntLE(length: number): Promise<number> {
    return (await this.read(length)).readIntLE(0, length);
  }

  public readU8(): Promise<number> {
    return this.readUIntBE(1);
  }

  public readU16BE(): Promise<number> {
    return this.readUIntBE(2);
  }

  public readU24BE(): Promise<number> {
    return this.readUIntBE(3);
  }

  public readU32BE(): Promise<number> {
    return this.readUIntBE(4);
  }

  public readU16LE(): Promise<number> {
    return this.readUIntLE(2);
  }

  public readU24LE(): Promise<number> {
    return this.readUIntLE(3);
  }

  public readU32LE(): Promise<number> {
    return this.readUIntLE(4);
  }

  public readI8(): Promise<number> {
    return this.readIntBE(1);
  }

  public readI16BE(): Promise<number> {
    return this.readIntBE(2);
  }

  public readI24BE(): Promise<number> {
    return this.readIntBE(3);
  }

  public readI32BE(): Promise<number> {
    return this.readIntBE(4);
  }

  public readI16LE(): Promise<number> {
    return this.readIntLE(2);
  }

  public readI24LE(): Promise<number> {
    return this.readIntLE(3);
  }

  public readI32LE(): Promise<number> {
    return this.readIntLE(4);
  }

  public async readF32BE(): Promise<number> {
    return (await this.read(4)).readFloatBE(0);
  }

  public async readF64BE(): Promise<number> {
    return (await this.read(8)).readDoubleBE(0);
  }

  public async readF32LE(): Promise<number> {
    return (await this.read(4)).readFloatLE(0);
  }

  public async readF64LE(): Promise<number> {
    return (await this.read(8)).readDoubleLE(0);
  }
}
