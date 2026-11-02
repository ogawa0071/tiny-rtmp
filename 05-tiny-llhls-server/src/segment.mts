export default class Segment {
  private timescale: number;
  private beginTimestamp: number;
  private endTimestamp: number | null = null;
  private buffers: Buffer[] = [];
  private keyframe: boolean = false;
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

  public abort(): void {
    this.completed.resolve(null);
  }

  public independent(): boolean {
    return this.keyframe;
  }
}
