export default class Segment {
  private timescale: number;
  private beginTimestamp: number;
  private endTimestamp: number | null = null;
  private media: Buffer[] = [];

  public constructor(timestamp: number, timescale: number) {
    this.beginTimestamp = timestamp;
    this.timescale = timescale;
  }

  public begin(): number {
    return this.beginTimestamp;
  }

  // セグメントの長さ (秒)
  public extinf(): number | null {
    const duration = this.duration();
    if (duration == null) { return null; }
    return duration / this.timescale;
  }

  // セグメントの長さ (timescale 単位)
  public duration(): number | null {
    if (this.endTimestamp == null) { return null; }
    return this.endTimestamp - this.beginTimestamp;
  }

  // 完成したセグメントのデータ (まだ完成していなければ null)
  public segment(): Buffer | null {
    if (this.endTimestamp == null) { return null; }
    return Buffer.concat(this.media);
  }

  public feed(data: Buffer): void {
    this.media.push(data);
  }

  public complete(timestamp: number): void {
    if (this.endTimestamp != null) { return; }
    this.endTimestamp = timestamp;
  }
}
