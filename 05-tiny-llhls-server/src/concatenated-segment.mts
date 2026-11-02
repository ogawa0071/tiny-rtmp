import Segment from './segment.mts';

export default class ConcatenatedSegment extends Segment {
  private parts: Segment[] = [];
  private pdt: Temporal.Instant;

  public constructor(timestamp: number, timescale: number, pdt: Temporal.Instant) {
    super(timestamp, timescale);
    this.parts.push(new Segment(timestamp, timescale));
    this.pdt = pdt;
  }

  private latest(): Segment {
    return this.parts.at(-1)!;
  }

  public latestBegin(): number {
    return this.latest().begin();
  }

  public latestIndex(): number {
    return this.parts.length - 1;
  }

  public programDateTime(): Temporal.Instant {
    return this.pdt;
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

  public complete(timestamp: number): void {
    this.latest().complete(timestamp);
    super.complete(timestamp);
  }

  public abort(): void {
    for (const part of this.parts) { part.abort(); }
    super.abort();
  }

  public partial(index: number): Segment | undefined {
    return this.parts[index];
  }

  public enumerate(): Iterable<[index: number, partialSegment: Segment]> {
    return this.parts.entries();
  }
}
