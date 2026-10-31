export default class Segment {
  private timescale: number;
  private beginTimestamp: number;
  private endTimestamp: number | null = null;
  private buffers: Buffer[] = [];
  private keyframe: boolean = false;
  // 完成したら完成したデータで、完成せずに捨てられたら null で解決する
  private completed = Promise.withResolvers<Buffer | null>();

  public constructor(timestamp: number, timescale: number) {
    this.timescale = timescale;
    this.beginTimestamp = timestamp;
  }

  public begin(): number {
    return this.beginTimestamp;
  }

  public extinf(): number | null {
    if (this.endTimestamp == null) { return null; }
    return (this.endTimestamp - this.beginTimestamp) / this.timescale;
  }

  // 作成中の (パーシャル) セグメントは、完成するまで 1 byte も返さずに待つ (RFC 8216bis 6.2.6)
  // (途中まで返すと、視聴者は届く速さから回線の帯域を正しく見積もれない)
  public data(): Promise<Buffer | null> {
    return this.completed.promise;
  }

  public feed(data: Buffer, keyframe: boolean = false): void {
    this.buffers.push(data);
    this.keyframe ||= keyframe;
  }

  public complete(timestamp: number): void {
    if (this.extinf() != null) { return; }
    this.endTimestamp = timestamp;
    this.completed.resolve(Buffer.concat(this.buffers));
  }

  // 完成させずに捨てる (完成を待っている視聴者には null を返す)
  public abort(): void {
    this.completed.resolve(null);
  }

  public independent(): boolean {
    return this.keyframe;
  }
}
