import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';

import ConcatenatedSegment from './concatenated-segment.mts';
import type Segment from './segment.mts';

const MINIMUM_LIVE_WINDOW_LENGTH = 3;

let latestSequenceNumber = 0;

const within = async <T,>(promise: Promise<T>, ms: number): Promise<T | null> => {
  const { promise: timeout, resolve } = Promise.withResolvers<null>();
  const timer = setTimeout(() => { resolve(null); }, ms);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export type MediaPlaylistOption = {
  liveWindowLength: number;
  partialSegmentDuration: number;
  minimumSegmentDuration: number;
};

export const MediaPlaylistOption = {
  from(option?: Partial<MediaPlaylistOption>): MediaPlaylistOption {
    return {
      ... option,
      liveWindowLength: Math.max(option?.liveWindowLength ?? MINIMUM_LIVE_WINDOW_LENGTH, MINIMUM_LIVE_WINDOW_LENGTH),
      partialSegmentDuration: Math.max(option?.partialSegmentDuration ?? 0.25, 0.25),
      minimumSegmentDuration: Math.max(option?.minimumSegmentDuration ?? 1, 1),
    };
  },
};

export default class MediaPlaylist {
  public published: Promise<boolean>;
  private publishedNotify: (success: boolean) => void;

  private sequenceNumber: number = Math.max(Math.floor(Date.now() / 100) - 1, latestSequenceNumber);

  private liveWindowLength: number;
  private partialSegmentDuration: number;
  private partialSegmentDurationDecided: boolean = false;
  private partialSegmentFrames: number = 0;
  private lastFrameLength: number | null = null;
  private partialSegmentExtra: number = 0;
  private longestPartialSegment: number = 0;
  private longestStalledPartialSegment: number = 0;

  private currentSegment: ConcatenatedSegment | null = null;
  private segmentMap: Map<number, ConcatenatedSegment> = new Map<number, ConcatenatedSegment>();
  private orphanedMap: Map<number, ConcatenatedSegment> = new Map<number, ConcatenatedSegment>();

  private minimumSegmentDuration: number;
  private targetduration: number | null = null;

  private origin: { pdt: Temporal.Instant; timestamp: number; } | null = null;
  private videoTimestamps: number[] = [];
  private pendingFrame: { timestamp: number; timescale: number; keyframe: boolean; data: Iterable<Buffer>[]; } | null = null;
  private partialSegmentStarted: () => void;
  private addedAt: number | null = null;
  private ended: boolean = false;
  private waiters: Set<() => void> = new Set<() => void>();

  public constructor(opt?: Partial<MediaPlaylistOption>, partialSegmentStarted: () => void = () => {}) {
    this.partialSegmentStarted = partialSegmentStarted;
    const option = MediaPlaylistOption.from(opt);
    this.liveWindowLength = option.liveWindowLength;
    this.partialSegmentDuration = option.partialSegmentDuration;
    this.minimumSegmentDuration = option.minimumSegmentDuration;

    const { promise: published, resolve: publishedNotify } = Promise.withResolvers<boolean>();
    this.published = published;
    this.publishedNotify = publishedNotify;
  }

  private videoFrameDuration(): number {
    const [latest, previous, before] = this.videoTimestamps;
    if (previous == null) { return 0; }
    if (before == null) { return latest - previous; }
    return Math.min(latest - previous, previous - before);
  }

  private decidePartialSegmentDuration(duration: number, timescale: number): void {
    const target = this.partialSegmentDuration * timescale;
    if (this.partialSegmentDurationDecided || duration > target) { return; }
    this.partialSegmentDurationDecided = true;

    const margin = timescale / 1000;
    const frames = this.partialSegmentFrames;
    const shortest = duration + margin > target ? duration * (frames - 1) / frames : duration - margin;
    if (shortest >= 0.85 * target) { return; }
    let partTarget = Math.max(duration, this.longestPartialSegment * timescale) + margin;
    const stalled = this.longestStalledPartialSegment * timescale + margin;
    if (stalled > partTarget && duration - margin >= 0.85 * stalled) { partTarget = stalled; }
    this.partialSegmentDuration = partTarget / timescale;
  }

  private decidePartialSegmentDurationForLowFrameRate(timescale: number): void {
    if (this.partialSegmentDurationDecided || this.videoTimestamps.length < 3) { return; }
    const frame = this.videoFrameDuration();
    if (frame <= this.partialSegmentDuration * timescale) { return; }
    this.partialSegmentDurationDecided = true;
    this.partialSegmentDuration = (frame + timescale / 1000) / timescale;
  }

  private recordPartialSegment(seconds: number): void {
    if (this.partialSegmentDurationDecided || seconds > this.partialSegmentDuration) { return; }
    if (this.stalled(seconds)) {
      this.longestStalledPartialSegment = Math.max(this.longestStalledPartialSegment, seconds);
    } else {
      this.longestPartialSegment = Math.max(this.longestPartialSegment, seconds);
    }
  }

  private stalled(seconds: number): boolean {
    return this.partialSegmentExtra > 0 && seconds - this.partialSegmentExtra - 0.001 < 0.85 * (seconds + 0.001);
  }

  private completePartialSegment(timestamp: number, timescale: number, now: number, decide: boolean): void {
    const segment = this.currentSegment!;
    const duration = timestamp - segment.latestBegin();
    if (decide && !this.stalled(duration / timescale)) { this.decidePartialSegmentDuration(duration, timescale); }
    this.recordPartialSegment(duration / timescale);
    segment.partialComplete(timestamp, timescale);
    this.partialSegmentStarted();
    this.partialSegmentFrames = 0;
    this.partialSegmentExtra = 0;
    this.addedAt = now;
    this.updated();
  }

  private flush(end: number): void {
    const frame = this.pendingFrame;
    if (frame == null) { return; }
    this.pendingFrame = null;

    const begin = this.currentSegment?.latestBegin();
    const target = this.partialSegmentDuration * frame.timescale;
    if (begin != null && frame.timestamp > begin && end - begin > target) {
      const regular = this.lastFrameLength != null && frame.timestamp + this.lastFrameLength + frame.timescale / 1000 - begin > target;
      this.completePartialSegment(frame.timestamp, frame.timescale, end, regular);
      this.partialSegmentExtra = regular || this.lastFrameLength == null ? 0 : (end - frame.timestamp - this.lastFrameLength) / frame.timescale;
    }
    for (const data of frame.data) {
      for (const buffer of data) { this.currentSegment?.feed(buffer, frame.keyframe); }
    }
    this.partialSegmentFrames += 1;
    this.lastFrameLength = end - frame.timestamp;
  }

  private updated(): void {
    for (const wakeup of this.waiters) { wakeup(); }
    this.waiters.clear();
  }

  private duration(): number {
    return this.segmentMap.values().reduce((total, segment) => total + segment.extinf()!, 0);
  }

  private completeCurrentSegment(timestamp: number): void {
    const segment = this.currentSegment!;
    segment.complete(timestamp);
    this.recordPartialSegment(segment.partial(segment.latestIndex())!.extinf()!);
    this.segmentMap.set(this.sequenceNumber, segment);
    this.targetduration = Math.max(this.targetduration ?? 0, Math.round(segment.extinf()!));

    while (this.segmentMap.size > this.liveWindowLength) {
      const [msn, oldest] = this.segmentMap.entries().next().value!;
      if (this.duration() - oldest.extinf()! < 3 * this.targetduration) { break; }
      this.segmentMap.delete(msn);
      this.orphanedMap.set(msn, oldest);
    }
    while (this.orphanedMap.size > this.segmentMap.size + 2) {
      this.orphanedMap.delete(this.orphanedMap.keys().next().value!);
    }
  }

  public append({ timestamp, timescale }: PlaylistTimestamp): boolean {
    if (this.ended) { return false; }
    this.flush(timestamp);
    if (this.currentSegment != null && (timestamp - this.currentSegment.begin()) < (this.minimumSegmentDuration * timescale)) {
      return false;
    }

    if (this.currentSegment != null) {
      this.completeCurrentSegment(timestamp);
    }
    this.sequenceNumber += 1;
    latestSequenceNumber = Math.max(latestSequenceNumber, this.sequenceNumber);
    this.origin ??= { pdt: Temporal.Now.instant(), timestamp };
    const pdt = this.origin.pdt.add({ milliseconds: Math.round((timestamp - this.origin.timestamp) * 1000 / timescale) });
    this.currentSegment = new ConcatenatedSegment(timestamp, timescale, pdt);
    this.partialSegmentFrames = 0;
    this.partialSegmentExtra = 0;
    this.addedAt = timestamp;
    this.updated();

    if (this.segmentMap.size >= MINIMUM_LIVE_WINDOW_LENGTH) {
      this.partialSegmentDurationDecided = true;
      this.publishedNotify(true);
    }
    return true;
  }

  public feed(data: Iterable<Buffer>, { timestamp, timescale }: PlaylistTimestamp, video: boolean, keyframe: boolean) {
    if (this.ended) { return; }
    if (!video) {
      if (this.pendingFrame != null) {
        this.pendingFrame.data.push(data);
      } else {
        for (const buffer of data) { this.currentSegment?.feed(buffer); }
      }
      return;
    }

    this.videoTimestamps = [timestamp, ... this.videoTimestamps].slice(0, 3);
    this.decidePartialSegmentDurationForLowFrameRate(timescale);
    this.flush(timestamp);
    const begin = this.currentSegment?.latestBegin();
    const target = this.partialSegmentDuration * timescale;
    const full = begin != null && timestamp - begin >= target;
    const late = this.partialSegmentDurationDecided && this.addedAt != null && timestamp + this.videoFrameDuration() - this.addedAt > target;
    if (begin != null && timestamp > begin && (full || late)) {
      this.completePartialSegment(timestamp, timescale, timestamp, true);
    }
    this.pendingFrame = { timestamp, timescale, keyframe, data: [data] };
  }

  public end(): void {
    if (this.ended) { return; }
    this.ended = true;
    const end = this.videoTimestamps.length === 0 ? null : this.videoTimestamps[0] + this.videoFrameDuration();
    if (end != null) { this.flush(end); }
    if (this.currentSegment != null && end != null && end > this.currentSegment.begin()) {
      this.completeCurrentSegment(end);
      this.sequenceNumber += 1;
    } else {
      this.currentSegment?.abort();
    }
    this.currentSegment = null;
    this.publishedNotify(this.segmentMap.size > 0);
    this.updated();
  }

  public m3u8(): string {
    const begin = this.sequenceNumber - this.segmentMap.size;

    let m3u8 = '';
    m3u8 += '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:6\n';
    m3u8 += `#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=${(this.partialSegmentDuration * 3.5).toFixed(6)}\n`;
    m3u8 += `#EXT-X-PART-INF:PART-TARGET=${this.partialSegmentDuration.toFixed(6)}\n`;
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:${begin}\n`;
    m3u8 += `#EXT-X-TARGETDURATION:${this.targetduration}\n`;
    m3u8 += '\n';
    for (const [msn, segment] of this.segmentMap) {
      m3u8 += `#EXT-X-PROGRAM-DATE-TIME:${segment.programDateTime().toString({ smallestUnit: 'millisecond' })}\n`;
      for (const [index, part] of segment.enumerate()) {
        m3u8 += `#EXT-X-PART:DURATION=${part.extinf()!.toFixed(6)},URI="${msn}_${index}.ts"` + (part.independent() ? ',INDEPENDENT=YES' : '') + '\n';
      }
      m3u8 += `#EXTINF:${segment.extinf()!.toFixed(6)},\n`;
      m3u8 += `${msn}.ts\n`;
    }
    if (this.ended) {
      m3u8 += '#EXT-X-ENDLIST\n';
      return m3u8;
    }

    if (this.currentSegment == null) { return m3u8; }
    m3u8 += `#EXT-X-PROGRAM-DATE-TIME:${this.currentSegment.programDateTime().toString({ smallestUnit: 'millisecond' })}\n`;
    for (const [index, part] of this.currentSegment.enumerate()) {
      const extinf = part.extinf();
      if (extinf != null) {
        m3u8 += `#EXT-X-PART:DURATION=${extinf.toFixed(6)},URI="${this.sequenceNumber}_${index}.ts"` + (part.independent() ? ',INDEPENDENT=YES' : '') + '\n';
      } else {
        m3u8 += `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${this.sequenceNumber}_${index}.ts"\n`;
      }
    }

    return m3u8;
  }

  public async get(msn: number, part: number | null): Promise<Buffer | null> {
    const segment = msn === this.sequenceNumber ? this.currentSegment : this.segmentMap.get(msn) ?? this.orphanedMap.get(msn);
    const target: Segment | null | undefined = part == null ? segment : segment?.partial(part);
    if (target == null) { return null; }
    return within(target.data(), 3 * (this.targetduration ?? 1) * 1000);
  }

  private contains(msn: number, part: number | null): boolean {
    if (msn > this.sequenceNumber) { return false; }
    if (msn < this.sequenceNumber) {
      const segment = this.segmentMap.get(msn) ?? this.orphanedMap.get(msn);
      if (part != null && segment != null && segment.partial(part) == null) { return this.contains(msn + 1, 0); }
      return true;
    }
    return part != null && this.currentSegment?.partial(part)?.extinf() != null;
  }

  public tooFar(msn: number, part: number | null): boolean {
    if (this.ended) { return false; }
    if (msn > (this.sequenceNumber - 1) + 2) { return true; }
    if (part == null || this.currentSegment == null) { return false; }
    const limit = this.partialSegmentDuration < 1 ? 3 / this.partialSegmentDuration : 3;
    const latest = this.currentSegment.latestIndex() - 1;
    if (msn === this.sequenceNumber) { return part - latest > limit; }
    if (msn === this.sequenceNumber + 1) { return 1 + (part + 1) > limit; }
    return false;
  }

  public async block(msn: number, part: number | null): Promise<boolean> {
    const deadline = performance.now() + 3 * (this.targetduration ?? 1) * 1000;
    while (!this.ended && !this.contains(msn, part)) {
      const remains = deadline - performance.now();
      if (remains <= 0) { return false; }
      await new Promise<void>((resolve) => {
        const wakeup = () => { clearTimeout(timer); this.waiters.delete(wakeup); resolve(); };
        const timer = setTimeout(wakeup, remains);
        this.waiters.add(wakeup);
      });
    }
    return true;
  }
}
