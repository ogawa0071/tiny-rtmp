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
  private segmentMap: Map<number, Segment> = new Map<number, Segment>();
  private orphanedMap: Map<number, Segment> = new Map<number, Segment>();

  private minimumSegmentDuration: number;
  private timescale: number;
  private firstSegmentBandwidth: number | null = null;

  public constructor(prefix: string, timescale: number, initialize: Buffer, opt?: Partial<SegmentTimelineOption>) {
    this.prefix = prefix;
    this.timescale = timescale;
    this.initializeSegment = initialize;
    const option = SegmentTimelineOption.from(opt);
    this.liveWindowLength = option.liveWindowLength;
    this.orphanedWindowLength = option.orphanedWindowLength;
    this.minimumSegmentDuration = option.minimumSegmentDuration;
  }

  public append(timestamp: number, force: boolean = false): boolean {
    if (this.currentSegment != null) {
      const duration = timestamp - this.currentSegment.begin();
      if (duration <= 0 || (!force && duration < this.minimumSegmentDuration * this.timescale)) { return false; }
    }

    if (this.currentSegment != null) {
      this.currentSegment.complete(timestamp);
      this.segmentMap.set(this.sequenceNumber, this.currentSegment);
      this.firstSegmentBandwidth ??= Math.ceil(this.currentSegment.segment()!.byteLength * 8 * this.timescale / this.currentSegment.duration()!);
    }
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

  public hasSegments(): boolean {
    return this.segmentMap.size > 0;
  }

  public bandwidth(): number | null {
    return this.firstSegmentBandwidth;
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
