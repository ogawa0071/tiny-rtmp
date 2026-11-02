import Segment from '../../04-tiny-hls-server/src/segment.mts';

import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';

const MINIMUM_LIVE_WINDOW_LENGTH = 3;

let latestSequenceNumber = 0;

export type MediaPlaylistOption = {
  liveWindowLength: number;
  minimumSegmentDuration: number;
};

export const MediaPlaylistOption = {
  from(option?: Partial<MediaPlaylistOption>): MediaPlaylistOption {
    return {
      ... option,
      liveWindowLength: Math.max(option?.liveWindowLength ?? MINIMUM_LIVE_WINDOW_LENGTH, MINIMUM_LIVE_WINDOW_LENGTH),
      minimumSegmentDuration: Math.max(option?.minimumSegmentDuration ?? 1, 1),
    };
  },
};

export default class MediaPlaylist {
  public published: Promise<boolean>;
  private publishedNotify: (success: boolean) => void;

  private sequenceNumber: number = Math.max(Math.floor(Date.now() / 100) - 1, latestSequenceNumber);

  private liveWindowLength: number;

  private currentSegment: Segment | null = null;
  private segmentMap: Map<number, Segment> = new Map<number, Segment>();
  private orphanedMap: Map<number, Segment> = new Map<number, Segment>();

  private minimumSegmentDuration: number;
  private targetduration: number | null = null;

  private ended: boolean = false;

  public constructor(opt?: Partial<MediaPlaylistOption>) {
    const option = MediaPlaylistOption.from(opt);
    this.liveWindowLength = option.liveWindowLength;
    this.minimumSegmentDuration = option.minimumSegmentDuration;

    const { promise: published, resolve: publishedNotify } = Promise.withResolvers<boolean>();
    this.published = published;
    this.publishedNotify = publishedNotify;
  }

  private duration(): number {
    return this.segmentMap.values().reduce((total, segment) => total + segment.extinf()!, 0);
  }

  private completeCurrentSegment(timestamp: number): void {
    const segment = this.currentSegment!;
    segment.complete(timestamp);
    this.segmentMap.set(this.sequenceNumber, segment);
    this.targetduration = Math.max(this.targetduration ?? 0, Math.round(segment.extinf()!));

    while (this.segmentMap.size > this.liveWindowLength) {
      const [msn, oldest] = this.segmentMap.entries().next().value!;
      if (this.duration() - oldest.extinf()! < 3 * this.targetduration) { break; }
      this.segmentMap.delete(msn);
      this.orphanedMap.set(msn, oldest);
    }
    while (this.orphanedMap.size > this.segmentMap.size + 1) {
      this.orphanedMap.delete(this.orphanedMap.keys().next().value!);
    }
  }

  public append({ timestamp, timescale }: PlaylistTimestamp): void {
    if (this.ended) { return; }
    if (this.currentSegment != null && (timestamp - this.currentSegment.begin()) < (this.minimumSegmentDuration * timescale)) {
      return;
    }

    if (this.currentSegment != null) {
      this.completeCurrentSegment(timestamp);
    }
    this.sequenceNumber += 1;
    latestSequenceNumber = Math.max(latestSequenceNumber, this.sequenceNumber);
    this.currentSegment = new Segment(timestamp, timescale);

    if (this.segmentMap.size >= MINIMUM_LIVE_WINDOW_LENGTH) {
      this.publishedNotify(true);
    }
  }

  public feed(data: Buffer): void {
    if (this.ended) { return; }
    this.currentSegment?.feed(data);
  }

  public end(end: PlaylistTimestamp | null): void {
    if (this.ended) { return; }
    this.ended = true;
    if (this.currentSegment != null && end != null && end.timestamp > this.currentSegment.begin()) {
      this.completeCurrentSegment(end.timestamp);
      this.sequenceNumber += 1;
    }
    this.currentSegment = null;
    this.publishedNotify(this.segmentMap.size > 0);
  }

  public m3u8(): string {
    const begin = this.sequenceNumber - this.segmentMap.size;

    let m3u8 = '';
    m3u8 += '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:6\n';
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:${begin}\n`;
    m3u8 += `#EXT-X-TARGETDURATION:${this.targetduration}\n`;
    m3u8 += '#EXT-X-MAP:URI="init.mp4"\n';
    m3u8 += '\n';
    for (const [msn, segment] of this.segmentMap) {
      m3u8 += `#EXTINF:${segment.extinf()!.toFixed(6)},\n`;
      m3u8 += `${msn}.m4s\n`;
    }
    if (this.ended) {
      m3u8 += '#EXT-X-ENDLIST\n';
    }

    return m3u8;
  }

  public segment(msn: number): Buffer | null {
    return (this.segmentMap.get(msn) ?? this.orphanedMap.get(msn))?.segment() ?? null;
  }
}
