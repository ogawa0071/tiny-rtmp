import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';

import ConcatenatedSegment from './concatenated-segment.mts';
import type Segment from './segment.mts';

const MINIMUM_LIVE_WINDOW_LENGTH = 3;

// このプロセスで最後に使ったメディアシーケンス番号 (配信し直した時は、これより大きい番号から始める)
let latestSequenceNumber = 0;

// promise が ms ミリ秒以内に解決すればその値を、間に合わなければ null を返す
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

  // 配信し直しても URI (セグメント名や _HLS_msn) が前の配信と重ならないように、番号を現在時刻から始める
  // セグメントは 1 秒以上なので、0.1 秒ごとに 1 進む時計 (UNIX 時間を 100 ミリ秒で割ったもの) から始めれば、前の配信の番号を越えられる
  // ただし実時間より速く届いた配信 (ffmpeg の -re なしなど) の番号は時計を追い越すので、このプロセスで使った番号よりは必ず大きくする
  // (前の配信の同じ URI のセグメントがキャッシュから使われないようにする: FFmpeg の -hls_start_number_source epoch と同じ考え方)
  private sequenceNumber: number = Math.max(Math.floor(Date.now() / 100) - 1, latestSequenceNumber);

  private liveWindowLength: number;
  private partialSegmentDuration: number;

  private currentSegment: ConcatenatedSegment | null = null;
  private segmentMap: Map<number, ConcatenatedSegment> = new Map<number, ConcatenatedSegment>(); // プレイリストに載せるセグメント
  private orphanedMap: Map<number, ConcatenatedSegment> = new Map<number, ConcatenatedSegment>(); // プレイリストから外れたが、まだ取得できるセグメント

  private minimumSegmentDuration: number;
  private targetduration: number | null = null;

  // EXT-X-PROGRAM-DATE-TIME の基準 (最初のセグメントの日時と、その timestamp)
  private origin: { pdt: Temporal.Instant; timestamp: number; } | null = null;
  // 直近の映像のフレームの timestamp (新しい順に 3 つまで、フレームの長さの見積もりに使う)
  private videoTimestamps: number[] = [];
  private ended: boolean = false;
  // プレイリストが更新されるのを待っている視聴者 (Blocking Playlist Reload)
  private waiters: Set<() => void> = new Set<() => void>();

  public constructor(opt?: Partial<MediaPlaylistOption>) {
    const option = MediaPlaylistOption.from(opt);
    this.liveWindowLength = option.liveWindowLength;
    this.partialSegmentDuration = option.partialSegmentDuration;
    this.minimumSegmentDuration = option.minimumSegmentDuration;

    const { promise: published, resolve: publishedNotify } = Promise.withResolvers<boolean>();
    this.published = published;
    this.publishedNotify = publishedNotify;
  }

  // 映像のフレームの長さの見積もり (次のフレームが来るまで分からないので、直前のフレームとの間隔を使う)
  // timestamp はミリ秒に丸められていて間隔が 1 ミリ秒ずれることがあるので、直近 2 つの間隔の短い方にする
  private videoFrameDuration(): number {
    const [latest, previous, before] = this.videoTimestamps;
    if (previous == null) { return 0; }
    if (before == null) { return latest - previous; }
    return Math.min(latest - previous, previous - before);
  }

  // プレイリストの更新を待っている視聴者を起こす
  private updated(): void {
    for (const wakeup of this.waiters) { wakeup(); }
    this.waiters.clear();
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
    // (LL-HLS のプレイリストには作成中のセグメントも載っているので、プレイリストのセグメント数より 2 つ多く残す)
    while (this.orphanedMap.size > this.segmentMap.size + 2) {
      this.orphanedMap.delete(this.orphanedMap.keys().next().value!);
    }
  }

  public append({ timestamp, timescale }: PlaylistTimestamp) {
    if (this.ended) { return; }
    if (this.currentSegment != null && (timestamp - this.currentSegment.begin()) < (this.minimumSegmentDuration * timescale)) {
      return;
    }

    if (this.currentSegment != null) {
      this.completeCurrentSegment(timestamp);
    }
    this.sequenceNumber += 1;
    latestSequenceNumber = Math.max(latestSequenceNumber, this.sequenceNumber);
    // EXT-X-PROGRAM-DATE-TIME は、最初のセグメントの日時に timestamp の差を足して決める
    // (届いた時刻を使うと、まとめて届いた時にセグメント同士の日時が重なって、日時とセグメントの対応が曖昧になる)
    this.origin ??= { pdt: Temporal.Now.instant(), timestamp };
    const pdt = this.origin.pdt.add({ milliseconds: Math.round((timestamp - this.origin.timestamp) * 1000 / timescale) });
    this.currentSegment = new ConcatenatedSegment(timestamp, timescale, pdt);
    this.updated();

    if (this.segmentMap.size >= MINIMUM_LIVE_WINDOW_LENGTH) {
      this.publishedNotify(true);
    }
  }

  // video: 映像のフレームか (パーシャルセグメントは、セグメントと同じく映像のフレームの境目で区切る)
  public feed(data: Iterable<Buffer>, { timestamp, timescale }: PlaylistTimestamp, video: boolean, keyframe: boolean) {
    if (this.ended) { return; }
    if (video) {
      this.videoTimestamps = [timestamp, ... this.videoTimestamps].slice(0, 3);
      // このフレームの終わりまで入れると PART-TARGET を超えるなら、このフレームから新しいパーシャルセグメントにする
      // (パーシャルセグメントの長さは PART-TARGET 以下でなければならない: RFC 8216bis 4.4.4.9)
      const begin = this.currentSegment?.latestBegin();
      if (begin != null && timestamp > begin && (timestamp + this.videoFrameDuration()) - begin > this.partialSegmentDuration * timescale) {
        this.currentSegment!.partialComplete(timestamp, timescale);
        this.updated();
      }
    }

    for (const buffer of data) {
      this.currentSegment?.feed(buffer, keyframe);
    }
  }

  // 配信の終了時に呼ぶ
  public end(): void {
    if (this.ended) { return; }
    this.ended = true;
    // 作成中のセグメントは、最後の映像のフレームの終わりまでで完成させる
    const end = this.videoTimestamps.length === 0 ? null : this.videoTimestamps[0] + this.videoFrameDuration();
    if (this.currentSegment != null && end != null && end > this.currentSegment.begin()) {
      this.completeCurrentSegment(end);
      this.sequenceNumber += 1;
    } else {
      this.currentSegment?.abort();
    }
    this.currentSegment = null;
    // プレイリストの公開や更新を待っている視聴者に、配信が終わったことを伝える
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
      // 日時はミリ秒の精度で書く (RFC 8216 4.3.2.6)
      m3u8 += `#EXT-X-PROGRAM-DATE-TIME:${segment.programDateTime().toString({ smallestUnit: 'millisecond' })}\n`;
      for (const [index, part] of segment.enumerate()) {
        m3u8 += `#EXT-X-PART:DURATION=${part.extinf()!.toFixed(6)},URI="${msn}_${index}.ts"` + (part.independent() ? ',INDEPENDENT=YES' : '') + '\n';
      }
      m3u8 += `#EXTINF:${segment.extinf()!.toFixed(6)},\n`; // #EXTINF:<duration>,[<title>] (タイトルは省略できるがカンマは必要)
      m3u8 += `${msn}.ts\n`;
    }
    // 配信が終わったら、これ以上セグメントが増えないことを伝える
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
        // まだ完成していないパーシャルセグメントは、先読みのヒントとして載せる
        m3u8 += `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${this.sequenceNumber}_${index}.ts"\n`;
      }
    }

    return m3u8;
  }

  // (パーシャル) セグメントのデータ (作成中なら完成するまで待つ)
  // 存在しない時、完成せずに捨てられた時、Target Duration の 3 倍待っても完成しない時 (配信が止まった時など) は null
  public async get(msn: number, part: number | null): Promise<Buffer | null> {
    const segment = msn === this.sequenceNumber ? this.currentSegment : this.segmentMap.get(msn) ?? this.orphanedMap.get(msn);
    const target: Segment | null | undefined = part == null ? segment : segment?.partial(part);
    if (target == null) { return null; }
    return within(target.data(), 3 * (this.targetduration ?? 1) * 1000);
  }

  // _HLS_msn と _HLS_part で指定された (パーシャル) セグメントが、プレイリストに載っているか
  private contains(msn: number, part: number | null): boolean {
    if (msn > this.sequenceNumber) { return false; }
    if (msn < this.sequenceNumber) {
      // 完成したセグメントの最後のパーシャルセグメントより後ろの番号は、次のセグメントの 0 番目として扱う (RFC 8216bis 6.2.5.2)
      // (もう残っていない古いセグメントなら、プレイリストはそれより先まで進んでいる)
      const segment = this.segmentMap.get(msn) ?? this.orphanedMap.get(msn);
      if (part != null && segment != null && segment.partial(part) == null) { return this.contains(msn + 1, 0); }
      return true;
    }
    // 作成中のセグメントは、完成したパーシャルセグメントだけがプレイリストに載っている
    return part != null && this.currentSegment?.partial(part)?.extinf() != null;
  }

  // 指定が先すぎるか (すぐに 400 Bad Request を返すべきか: RFC 8216bis 6.2.5.2)
  public tooFar(msn: number, part: number | null): boolean {
    // 配信が終わっていれば、指定は無視してプレイリストを返す
    if (this.ended) { return false; }
    // セグメントは、最後の (完成した) セグメントの 2 つ先まで (作成中のセグメントは、まだセグメントとしては載っていない)
    if (msn > (this.sequenceNumber - 1) + 2) { return true; }
    if (part == null || this.currentSegment == null) { return false; }
    // パーシャルセグメントは、最後に完成したもの (今書き込んでいるものの 1 つ前) から
    // Advance Part Limit (PART-TARGET が 1 秒未満なら 3 / PART-TARGET、それ以外は 3) 先まで
    const limit = this.partialSegmentDuration < 1 ? 3 / this.partialSegmentDuration : 3;
    const latest = this.currentSegment.latestIndex() - 1;
    if (msn === this.sequenceNumber) { return part - latest > limit; }
    // 次のセグメントのパーシャルセグメントは、少なくとも今書き込んでいるものと、次のセグメントの 0〜part 番目の分だけ先にある
    if (msn === this.sequenceNumber + 1) { return 1 + (part + 1) > limit; }
    return false;
  }

  // 指定された (パーシャル) セグメントがプレイリストに載るまで待つ (Blocking Playlist Reload)
  // Target Duration の 3 倍待っても載らなければ false を返す (503 Service Unavailable を返すべき: RFC 8216bis 6.2.5.2)
  public async block(msn: number, part: number | null): Promise<boolean> {
    const deadline = performance.now() + 3 * (this.targetduration ?? 1) * 1000;
    // 配信が終わっていれば、それ以上は待たない (EXT-X-ENDLIST があれば _HLS_msn と _HLS_part は無視する)
    while (!this.ended && !this.contains(msn, part)) {
      const remains = deadline - performance.now();
      if (remains <= 0) { return false; }
      await new Promise<void>((resolve) => {
        // 時間切れでも更新でも、待つのをやめる時は自分を waiters から外す
        const wakeup = () => { clearTimeout(timer); this.waiters.delete(wakeup); resolve(); };
        const timer = setTimeout(wakeup, remains);
        this.waiters.add(wakeup);
      });
    }
    return true;
  }
}
