import type { PlaylistTimestamp } from './playlist-timestamp.mts';
import Segment from './segment.mts';

const MINIMUM_LIVE_WINDOW_LENGTH = 3;

// このプロセスで最後に使ったメディアシーケンス番号 (配信し直した時は、これより大きい番号から始める)
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

  // 配信し直しても URI (セグメント名) が前の配信と重ならないように、番号を現在時刻から始める
  // セグメントは 1 秒以上なので、0.1 秒ごとに 1 進む時計 (UNIX 時間を 100 ミリ秒で割ったもの) から始めれば、前の配信の番号を越えられる
  // ただし実時間より速く届いた配信 (ffmpeg の -re なしなど) の番号は時計を追い越すので、このプロセスで使った番号よりは必ず大きくする
  // (前の配信の同じ URI のセグメントがキャッシュから使われないようにする: FFmpeg の -hls_start_number_source epoch と同じ考え方)
  private sequenceNumber: number = Math.max(Math.floor(Date.now() / 100) - 1, latestSequenceNumber);

  private liveWindowLength: number;

  private currentSegment: Segment | null = null;
  private segmentMap: Map<number, Segment> = new Map<number, Segment>(); // プレイリストに載せるセグメント
  private orphanedMap: Map<number, Segment> = new Map<number, Segment>(); // プレイリストから外れたが、まだ取得できるセグメント

  private minimumSegmentDuration: number;
  private targetduration: number | null = null;

  // 最後に届いた映像のフレームの timestamp (配信の終了時に、作成中のセグメントを完成させるのに使う。映像のない配信では音声のフレーム)
  // セグメントは映像のキーフレームで区切るので、最後のセグメントも映像の時刻で終わらせる (FFmpeg の HLS 出力も、セグメントの長さは映像から決める)
  // (映像の timestamp は DTS で、B フレームがあると表示時刻より早いので、映像と同時に終わる音声の timestamp が、次のキーフレームが来るはずだった時刻を越えることがある。
  //  音声の時刻まで使うと最後のセグメントだけが長くなり、EXT-X-TARGETDURATION が配信の最後に変わってしまう (RFC 8216 6.2.1 で禁止))
  private latestTimestamp: number | null = null;
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
    // EXT-X-TARGETDURATION は全てのセグメントの長さ以上である必要があるので、一番長いセグメントに合わせる
    this.targetduration = Math.max(this.targetduration ?? 0, Math.ceil(segment.extinf()!));

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

  // timestamp から新しいセグメントを始める (始めたら true を返す)
  // 今のセグメントがまだ minimumSegmentDuration より短ければ、新しいセグメントは始めずに今のセグメントに続ける
  public append({ timestamp, timescale }: PlaylistTimestamp): boolean {
    if (this.ended) { return false; }
    if (this.currentSegment != null && (timestamp - this.currentSegment.begin()) < (this.minimumSegmentDuration * timescale)) {
      return false;
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
    return true;
  }

  // video: 映像のフレームか (映像のない配信では、セグメントを区切る音声のフレームか)
  public feed(data: Iterable<Buffer>, { timestamp }: PlaylistTimestamp, video: boolean): void {
    if (this.ended) { return; }
    for (const buffer of data) { this.currentSegment?.feed(buffer); }
    if (video) { this.latestTimestamp = timestamp; }
  }

  // 配信の終了時に呼ぶ
  public end(): void {
    if (this.ended) { return; }
    this.ended = true;
    // 作成中のセグメントは、最後に届いた映像のフレームの時刻までで完成させる (最後のフレームの長さは分からないので含めない)
    if (this.currentSegment != null && this.latestTimestamp != null && this.latestTimestamp > this.currentSegment.begin()) {
      this.completeCurrentSegment(this.latestTimestamp);
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
    m3u8 += '#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:${begin}\n`;
    m3u8 += `#EXT-X-TARGETDURATION:${this.targetduration}\n`;
    m3u8 += '\n';
    for (const [msn, segment] of this.segmentMap) {
      m3u8 += `#EXTINF:${segment.extinf()!.toFixed(6)},\n`; // #EXTINF:<duration>,[<title>] (タイトルは省略できるがカンマは必要)
      m3u8 += `${msn}.ts\n`;
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
