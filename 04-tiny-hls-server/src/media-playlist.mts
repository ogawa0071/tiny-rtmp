import type { PlaylistTimestamp } from './playlist-timestamp.mts';
import Segment from './segment.mts';

const MINIMUM_LIVE_WINDOW_LENGTH = 3;

export type MediaPlaylistOption = {
  liveWindowLength: number;
  orphanedWindowLength: number;
  minimumSegmentDuration: number;
};

export const MediaPlaylistOption = {
  from(option?: Partial<MediaPlaylistOption>): MediaPlaylistOption {
    return {
      ... option,
      liveWindowLength: Math.max(option?.liveWindowLength ?? MINIMUM_LIVE_WINDOW_LENGTH, MINIMUM_LIVE_WINDOW_LENGTH),
      orphanedWindowLength: Math.max(option?.orphanedWindowLength ?? MINIMUM_LIVE_WINDOW_LENGTH, MINIMUM_LIVE_WINDOW_LENGTH),
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

  private currentSegment: Segment | null = null;
  private segmentMap: Map<number, Segment> = new Map<number, Segment>(); // プレイリストに載せるセグメント
  private orphanedMap: Map<number, Segment> = new Map<number, Segment>(); // プレイリストから外れたが、まだ取得できるセグメント

  private minimumSegmentDuration: number;
  private targetduration: number | null = null;

  public constructor(opt?: Partial<MediaPlaylistOption>) {
    const option = MediaPlaylistOption.from(opt);
    this.liveWindowLength = option.liveWindowLength;
    this.orphanedWindowLength = option.orphanedWindowLength;
    this.minimumSegmentDuration = option.minimumSegmentDuration;

    const { promise: published, resolve: publishedNotify } = Promise.withResolvers<boolean>();
    this.published = published;
    this.publishedNotify = publishedNotify;
  }

  public append({ timestamp, timescale }: PlaylistTimestamp): void {
    if (this.currentSegment != null && (timestamp - this.currentSegment.begin()) < (this.minimumSegmentDuration * timescale)) {
      return;
    }

    if (this.currentSegment != null) {
      this.currentSegment.complete(timestamp);
      this.segmentMap.set(this.sequenceNumber, this.currentSegment);
      // EXT-X-TARGETDURATION は全てのセグメントの長さ以上である必要があるので、一番長いセグメントに合わせる
      this.targetduration = Math.max(this.targetduration ?? 0, Math.ceil(this.currentSegment.extinf()!));
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
    this.currentSegment = new Segment(timestamp, timescale);

    if (this.segmentMap.size >= MINIMUM_LIVE_WINDOW_LENGTH) {
      this.publishedNotify(true);
    }
  }

  public feed(data: Iterable<Buffer>): void {
    for (const buffer of data) { this.currentSegment?.feed(buffer); }
  }

  // 配信の終了時に呼ぶ (プレイリストを公開できるまで待っている視聴者に、公開できなかったことを伝える)
  public end(): void {
    this.publishedNotify(false);
  }

  public m3u8(): string {
    const begin = Math.max(0, this.sequenceNumber - this.liveWindowLength);

    let m3u8 = '';
    m3u8 += '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:${begin}\n`;
    m3u8 += `#EXT-X-TARGETDURATION:${this.targetduration}\n`;
    m3u8 += '\n';
    for (let i = begin; i < this.sequenceNumber; i++) {
      const segment = this.segmentMap.get(i)!;
      m3u8 += `#EXTINF:${segment.extinf()!.toFixed(6)},\n`; // #EXTINF:<duration>,[<title>] (タイトルは省略できるがカンマは必要)
      m3u8 += `${i}.ts\n`;
    }

    return m3u8;
  }

  public segment(msn: number): Buffer | null {
    return (this.segmentMap.get(msn) ?? this.orphanedMap.get(msn))?.segment() ?? null;
  }
}
