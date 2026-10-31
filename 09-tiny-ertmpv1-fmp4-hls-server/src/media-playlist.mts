import Segment from '../../04-tiny-hls-server/src/segment.mts';

import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';

const MINIMUM_LIVE_WINDOW_LENGTH = 3;

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

// HLS (04-tiny-hls-server) の MediaPlaylist の、セグメントが fMP4 になったもの
export default class MediaPlaylist {
  public published: Promise<boolean>;
  private publishedNotify: (success: boolean) => void;

  private sequenceNumber: number = -1;

  private liveWindowLength: number;

  private currentSegment: Segment | null = null;
  private segmentMap: Map<number, Segment> = new Map<number, Segment>(); // プレイリストに載せるセグメント
  private orphanedMap: Map<number, Segment> = new Map<number, Segment>(); // プレイリストから外れたが、まだ取得できるセグメント

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

  // プレイリストに載っているセグメントの長さの合計 (秒)
  private duration(): number {
    return this.segmentMap.values().reduce((total, segment) => total + segment.extinf()!, 0);
  }

  // 作成中のセグメントを完成させて、プレイリストに載せる
  private completeCurrentSegment(timestamp: number): void {
    const segment = this.currentSegment!;
    segment.complete(timestamp);
    this.segmentMap.set(this.sequenceNumber, segment);
    // EXT-X-TARGETDURATION は一番長いセグメントに合わせる (バージョン 6 以降では、セグメントの長さを整数に丸めた値でよい)
    this.targetduration = Math.max(this.targetduration ?? 0, Math.round(segment.extinf()!));

    // 古いセグメントをライブウィンドウから外す
    // ただし、プレイリストの長さが Target Duration の 3 倍より短くなるようには外せない (RFC 8216 6.2.2)
    while (this.segmentMap.size > this.liveWindowLength) {
      const [msn, oldest] = this.segmentMap.entries().next().value!;
      if (this.duration() - oldest.extinf()! < 3 * this.targetduration) { break; }
      this.segmentMap.delete(msn);
      this.orphanedMap.set(msn, oldest);
    }
    // 外したセグメントは、そのセグメントとプレイリストの長さの分の間は取得できる必要がある (RFC 8216 6.2.2)
    // (プレイリストを取得済みの視聴者のために、プレイリストのセグメント数より 1 つ多く残す)
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
    this.currentSegment = new Segment(timestamp, timescale);

    if (this.segmentMap.size >= MINIMUM_LIVE_WINDOW_LENGTH) {
      this.publishedNotify(true);
    }
  }

  public feed(data: Buffer): void {
    if (this.ended) { return; }
    this.currentSegment?.feed(data);
  }

  // 配信の終了時に呼ぶ (作成中のセグメントは、書き出したデータの終わりの時刻で完成させる)
  public end(end: PlaylistTimestamp | null): void {
    if (this.ended) { return; }
    this.ended = true;
    if (this.currentSegment != null && end != null && end.timestamp > this.currentSegment.begin()) {
      this.completeCurrentSegment(end.timestamp);
      this.sequenceNumber += 1;
    }
    this.currentSegment = null;
    // プレイリストを公開できるまで待っている視聴者に、公開できるか (セグメントがあるか) を伝える
    this.publishedNotify(this.segmentMap.size > 0);
  }

  public m3u8(): string {
    const begin = this.sequenceNumber - this.segmentMap.size;

    let m3u8 = '';
    m3u8 += '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:6\n'; // EXT-X-MAP を使うには version 6 以上が必要
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:${begin}\n`;
    m3u8 += `#EXT-X-TARGETDURATION:${this.targetduration}\n`;
    // セグメントはキーフレーム (IDR) から始まるので、(初期化セグメントがあれば) 他のセグメントなしでデコードできる
    m3u8 += '#EXT-X-INDEPENDENT-SEGMENTS\n';
    // fMP4 のセグメントは moof + mdat だけなので、デコードに必要な初期化セグメント (ftyp + moov) を指定する
    m3u8 += '#EXT-X-MAP:URI="init.mp4"\n';
    m3u8 += '\n';
    for (const [msn, segment] of this.segmentMap) {
      m3u8 += `#EXTINF:${segment.extinf()!.toFixed(6)},\n`; // #EXTINF:<duration>,[<title>] (タイトルは省略できるがカンマは必要)
      m3u8 += `${msn}.m4s\n`;
    }
    // 配信が終わったら、これ以上セグメントが増えないことを伝える
    if (this.ended) {
      m3u8 += '#EXT-X-ENDLIST\n';
    }

    return m3u8;
  }

  public segment(msn: number): Buffer | null {
    return (this.segmentMap.get(msn) ?? this.orphanedMap.get(msn))?.segment() ?? null;
  }
}
