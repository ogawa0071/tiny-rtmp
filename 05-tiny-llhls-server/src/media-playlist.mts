import { Writable } from 'node:stream';

import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';

import ConcatenatedSegment from './concatenated-segment.mts';

const MINIMUM_LIVE_WINDOW_LENGTH = 3;

export type MediaPlaylistOption = {
  liveWindowLength: number;
  orphanedWindowLength: number;
  partialSegmentDuration: number;
  minimumSegmentDuration: number;
};

export const MediaPlaylistOption = {
  from(option?: Partial<MediaPlaylistOption>): MediaPlaylistOption {
    return {
      ... option,
      liveWindowLength: Math.max(option?.liveWindowLength ?? MINIMUM_LIVE_WINDOW_LENGTH, MINIMUM_LIVE_WINDOW_LENGTH),
      orphanedWindowLength: Math.max(option?.orphanedWindowLength ?? MINIMUM_LIVE_WINDOW_LENGTH, MINIMUM_LIVE_WINDOW_LENGTH),
      partialSegmentDuration: Math.max(option?.partialSegmentDuration ?? 0.25, 0.25),
      minimumSegmentDuration: Math.max(option?.minimumSegmentDuration ?? 1, 1),
    };
  },
};

export default class MediaPlaylist {
  public published: Promise<boolean>;
  private publishedNotify: (success: boolean) => void;

  private sequenceNumber: number = -1;

  private liveWindowLength: number;
  private orphanedWindowLength: number;
  private partialSegmentDuration: number;

  private currentSegment: ConcatenatedSegment | null = null;
  private segmentMap: Map<number, ConcatenatedSegment> = new Map<number, ConcatenatedSegment>(); // プレイリストに載せるセグメント
  private orphanedMap: Map<number, ConcatenatedSegment> = new Map<number, ConcatenatedSegment>(); // プレイリストから外れたが、まだ取得できるセグメント

  private minimumSegmentDuration: number;
  private targetduration: number | null = null;

  public constructor(opt?: Partial<MediaPlaylistOption>) {
    const option = MediaPlaylistOption.from(opt);
    this.liveWindowLength = option.liveWindowLength;
    this.orphanedWindowLength = option.orphanedWindowLength;
    this.partialSegmentDuration = option.partialSegmentDuration;
    this.minimumSegmentDuration = option.minimumSegmentDuration;

    const { promise: published, resolve: publishedNotify } = Promise.withResolvers<boolean>();
    this.published = published;
    this.publishedNotify = publishedNotify;
  }

  public append({ timestamp, timescale }: PlaylistTimestamp) {
    if (this.currentSegment != null && (timestamp - this.currentSegment.begin()) < (this.minimumSegmentDuration * timescale)) {
      return;
    }
    const previousSegment = this.currentSegment;

    if (previousSegment != null) {
      // 完成を待っている視聴者への通知は、次のセグメントをプレイリストに載せてから行う
      previousSegment.complete(timestamp, false);
      this.segmentMap.set(this.sequenceNumber, previousSegment);
      // EXT-X-TARGETDURATION は全てのセグメントの長さ以上である必要があるので、一番長いセグメントに合わせる
      this.targetduration = Math.max(this.targetduration ?? 0, Math.ceil(previousSegment.extinf()!));
    }
    // ライブウィンドウから外れたセグメントは、プレイリストを取得済みの視聴者のために少しの間だけ残しておく
    const orphaned = this.sequenceNumber - this.liveWindowLength;
    const orphanedSegment = this.segmentMap.get(orphaned);
    if (orphanedSegment != null) {
      this.orphanedMap.set(orphaned, orphanedSegment);
      this.segmentMap.delete(orphaned);
    }
    this.orphanedMap.delete(orphaned - this.orphanedWindowLength);

    this.sequenceNumber += 1;
    this.currentSegment = new ConcatenatedSegment(timestamp, timescale, new Date());
    previousSegment?.notify();

    if (this.segmentMap.size >= MINIMUM_LIVE_WINDOW_LENGTH) {
      this.publishedNotify(true);
    }
  }

  public feed(data: Iterable<Buffer>, { timestamp, timescale }: PlaylistTimestamp, keyframe: boolean = false) {
    if (this.currentSegment != null && (timestamp - this.currentSegment.latestBegin()) > (this.partialSegmentDuration * timescale)) {
      this.currentSegment.partialComplete(this.currentSegment.latestBegin() + (this.partialSegmentDuration * timescale), timescale);
    }

    for (const buffer of data) {
      this.currentSegment?.feed(buffer, keyframe);
    }
  }

  // 配信の終了時に呼ぶ (プレイリストを公開できるまで待っている視聴者に、公開できなかったことを伝える)
  public end(): void {
    this.publishedNotify(false);
  }

  public m3u8(): string {
    const begin = Math.max(0, this.sequenceNumber - this.liveWindowLength);

    let m3u8 = '';
    m3u8 += '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:6\n';
    m3u8 += `#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=${(this.partialSegmentDuration * 3.5).toFixed(6)}\n`;
    m3u8 += `#EXT-X-PART-INF:PART-TARGET=${this.partialSegmentDuration.toFixed(6)}\n`;
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:${begin}\n`;
    m3u8 += `#EXT-X-TARGETDURATION:${this.targetduration}\n`;
    m3u8 += '\n';
    for (let i = begin; i < this.sequenceNumber; i++) {
      const segment = this.segmentMap.get(i)!;
      const programDateTime = segment.programDateTime();
      if (programDateTime != null) {
        m3u8 += `#EXT-X-PROGRAM-DATE-TIME:${programDateTime.toISOString()}\n`;
      }
      for (const [index, part] of segment.enumerate()) {
        m3u8 += `#EXT-X-PART:DURATION=${part.extinf()!.toFixed(6)},URI="${i}_${index}.ts"` + (part.independent() ? ',INDEPENDENT=YES' : '') + '\n';
      }
      m3u8 += `#EXTINF:${segment.extinf()!.toFixed(6)}\n`;
      m3u8 += `${i}.ts\n`;
    }

    if (this.currentSegment == null) { return m3u8; }
    const currentProgramDateTime = this.currentSegment.programDateTime();
    if (currentProgramDateTime != null) {
      m3u8 += `#EXT-X-PROGRAM-DATE-TIME:${currentProgramDateTime.toISOString()}\n`;
    }
    for (const [index, part] of this.currentSegment.enumerate()) {
      const extinf = part.extinf();
      if (extinf != null) {
        m3u8 += `#EXT-X-PART:DURATION=${extinf.toFixed(6)},URI="${this.sequenceNumber}_${index}.ts"` + (part.independent() ? ',INDEPENDENT=YES' : '') + '\n';
      } else {
        // まだ完成していないパーシャルセグメントは、先読みのヒントとして載せる
        m3u8 += `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${this.sequenceNumber}_${index}.ts"\n`;
      }
    }

    return m3u8;
  }

  public stream(msn: number, part: number | null, writable: Writable, cb?: (found: boolean) => void): void {
    const segment = msn === this.sequenceNumber ? this.currentSegment : this.segmentMap.get(msn) ?? this.orphanedMap.get(msn);
    if (segment == null) {
      cb?.(false);
      writable.end();
      return;
    }
    if (part == null) {
      cb?.(true);
      segment.attach(writable);
      return;
    }
    const partial = segment.partial(part);
    if (partial == null) {
      cb?.(false);
      writable.end();
      return;
    }
    cb?.(true);
    partial.attach(writable);
    return;
  }

  public block(msn: number, part: number | null): Promise<void> {
    if (msn !== this.sequenceNumber || this.currentSegment == null) {
      return Promise.resolve();
    }
    if (part == null) {
      return this.currentSegment.promise();
    }
    const partial = this.currentSegment.partial(part);
    if (partial == null) {
      return Promise.resolve();
    }
    return partial.promise();
  }
}
