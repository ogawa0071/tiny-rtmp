import Segment from '../../04-tiny-hls-server/src/segment.mts';

import { XMLNode } from './xml.mts';

const MINIMUM_LIVE_WINDOW_LENGTH = 3;

export type SegmentTimelineOption = {
  liveWindowLength: number;
  orphanedWindowLength: number;
  minimumSegmentDuration: number;
};

export const SegmentTimelineOption = {
  from(option?: Partial<SegmentTimelineOption>): SegmentTimelineOption {
    return {
      ... option,
      liveWindowLength: Math.max(option?.liveWindowLength ?? MINIMUM_LIVE_WINDOW_LENGTH, MINIMUM_LIVE_WINDOW_LENGTH),
      orphanedWindowLength: Math.max(option?.orphanedWindowLength ?? MINIMUM_LIVE_WINDOW_LENGTH, MINIMUM_LIVE_WINDOW_LENGTH),
      minimumSegmentDuration: Math.max(option?.minimumSegmentDuration ?? 1, 1),
    };
  },
};

export default class SegmentTimeline {
  private prefix: string;

  private sequenceNumber: number = -1;

  private liveWindowLength: number;
  private orphanedWindowLength: number;

  private initializeSegment: Buffer;
  private currentSegment: Segment | null = null;
  private segmentMap: Map<number, Segment> = new Map<number, Segment>(); // MPD に載せるセグメント
  private orphanedMap: Map<number, Segment> = new Map<number, Segment>(); // MPD から外れたが、まだ取得できるセグメント

  private minimumSegmentDuration: number;
  private timescale: number;

  public constructor(prefix: string, timescale: number, initialize: Buffer, opt?: Partial<SegmentTimelineOption>) {
    this.prefix = prefix;
    this.timescale = timescale;
    this.initializeSegment = initialize;
    const option = SegmentTimelineOption.from(opt);
    this.liveWindowLength = option.liveWindowLength;
    this.orphanedWindowLength = option.orphanedWindowLength;
    this.minimumSegmentDuration = option.minimumSegmentDuration;
  }

  // 新しいセグメントを始めたら true を返す
  // force の時は最小の長さを確認しない (映像に合わせて音声を区切る時用) が、長さ 0 のセグメントは作らない
  public append(timestamp: number, force: boolean = false): boolean {
    if (this.currentSegment != null) {
      const duration = timestamp - this.currentSegment.begin();
      if (duration <= 0 || (!force && duration < this.minimumSegmentDuration * this.timescale)) { return false; }
    }

    if (this.currentSegment != null) {
      this.currentSegment.complete(timestamp);
      this.segmentMap.set(this.sequenceNumber, this.currentSegment);
    }
    // ライブウィンドウから外れたセグメントは、MPD を取得済みの視聴者のために少しの間だけ残しておく
    const orphaned = this.sequenceNumber - this.liveWindowLength;
    const orphanedSegment = this.segmentMap.get(orphaned);
    if (orphanedSegment != null) {
      this.orphanedMap.set(orphaned, orphanedSegment);
      this.segmentMap.delete(orphaned);
    }
    this.orphanedMap.delete(orphaned - this.orphanedWindowLength);

    this.sequenceNumber += 1;
    this.currentSegment = new Segment(timestamp, this.timescale);
    return true;
  }

  // MPD に載せる @bandwidth (ライブウィンドウ内のセグメントの最大ビットレート)
  public bandwidth(): number {
    let bandwidth = 0;
    for (const segment of this.segmentMap.values()) {
      bandwidth = Math.max(bandwidth, Math.ceil(segment.segment()!.byteLength * 8 * this.timescale / Math.max(1, segment.duration()!)));
    }
    return bandwidth;
  }

  public feed(data: Buffer): void {
    this.currentSegment?.feed(data);
  }

  public segment_template(): XMLNode {
    const begin = Math.max(0, this.sequenceNumber - this.liveWindowLength);
    const template = XMLNode.from('SegmentTemplate', {
      timescale: `${this.timescale}`,
      media: `${this.prefix}_$Number$.m4s`,
      initialization: `${this.prefix}_init.mp4`,
      startNumber: `${begin}`,
    });

    // 各セグメントの開始時刻 (t) と長さ (d) の一覧
    const timeline = XMLNode.from('SegmentTimeline');
    for (let i = begin; i < this.sequenceNumber; i++) {
      const segment = this.segmentMap.get(i)!;
      const S = XMLNode.from('S', { t: `${segment.begin()}`, d: `${segment.duration()!}` });
      timeline.children.push(S);
    }
    template.children.push(timeline);

    return template;
  }

  public initialize(): Buffer | null {
    return this.initializeSegment;
  }

  public segment(msn: number): Buffer | null {
    return (this.segmentMap.get(msn) ?? this.orphanedMap.get(msn))?.segment() ?? null;
  }
}
