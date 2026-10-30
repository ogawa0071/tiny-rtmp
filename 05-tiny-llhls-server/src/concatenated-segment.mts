import Segment from './segment.mts';

// パーシャルセグメントを連結したセグメント (データは自身とパーシャルセグメントの両方に書き込む)
export default class ConcatenatedSegment extends Segment {
  private parts: Segment[] = [];

  public constructor(timestamp: number, timescale: number, pdt?: Date) {
    super(timestamp, timescale, pdt);
    this.parts.push(new Segment(timestamp, timescale));
  }

  // 今書き込んでいるパーシャルセグメント
  private latest(): Segment {
    return this.parts.at(-1)!;
  }

  public latestBegin(): number {
    return this.latest().begin();
  }

  public partialComplete(timestamp: number, timescale: number): void {
    const part = this.latest();
    this.parts.push(new Segment(timestamp, timescale));
    part.complete(timestamp);
  }

  public feed(buffer: Buffer, keyframe: boolean = false): void {
    this.latest().feed(buffer, keyframe);
    super.feed(buffer, keyframe);
  }

  public complete(timestamp: number, notify: boolean = true): void {
    if (this.extinf() != null) { return; }
    this.latest().complete(timestamp, false);
    super.complete(timestamp, false);
    if (!notify) { return; }
    this.notify();
  }

  public notify(): void {
    this.latest().notify();
    super.notify();
  }

  public partial(index: number): Segment | undefined {
    return this.parts[index];
  }

  public enumerate(): Iterable<[index: number, partialSegment: Segment]> {
    return this.parts.entries();
  }
}
