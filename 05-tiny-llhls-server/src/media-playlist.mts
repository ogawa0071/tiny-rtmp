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
  // PART-TARGET (パーシャルセグメントの長さの上限、秒)
  private partialSegmentDuration: number;
  // PART-TARGET を決めたか (決めた後は変えない: decidePartialSegmentDuration)
  private partialSegmentDurationDecided: boolean = false;
  // 今書き込んでいるパーシャルセグメントに入れた映像のフレームの数
  private partialSegmentFrames: number = 0;
  // 最後にパーシャルセグメントに入れた映像のフレームの長さ (フレームが欠けたり映像が途切れたりしたかを見るのに使う)
  private lastFrameLength: number | null = null;
  // PART-TARGET を決める前に作ったパーシャルセグメントの長さの最大 (秒、1 フレームだけで PART-TARGET より長いものは除く)
  private longestPartialSegment: number = 0;

  private currentSegment: ConcatenatedSegment | null = null;
  private segmentMap: Map<number, ConcatenatedSegment> = new Map<number, ConcatenatedSegment>(); // プレイリストに載せるセグメント
  private orphanedMap: Map<number, ConcatenatedSegment> = new Map<number, ConcatenatedSegment>(); // プレイリストから外れたが、まだ取得できるセグメント

  private minimumSegmentDuration: number;
  private targetduration: number | null = null;

  // EXT-X-PROGRAM-DATE-TIME の基準 (最初のセグメントの日時と、その timestamp)
  private origin: { pdt: Temporal.Instant; timestamp: number; } | null = null;
  // 直近の映像のフレームの timestamp (新しい順に 3 つまで、フレームの長さを見積もるのに使う)
  private videoTimestamps: number[] = [];
  // 最後に届いた映像のフレームと、その後に届いた音声などのデータ (まだパーシャルセグメントに入れていない)
  // フレームの長さは次の映像のフレームが届くまで分からないので、それまではどのパーシャルセグメントに入れるかを決めない
  private pendingFrame: { timestamp: number; timescale: number; keyframe: boolean; buffers: Buffer[]; } | null = null;
  // 最後に (パーシャル) セグメントをプレイリストに追加した時刻 (その時に届いた映像のフレームの timestamp)
  // パーシャルセグメントは、1 つ前のものを追加してから PART-TARGET 以内に追加しなければならない (RFC 8216bis 6.2.1)
  private addedAt: number | null = null;
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

  // 映像のフレームの長さの見積もり (直前のフレームとの間隔を使う: 最後に届いたフレームの長さは、次のフレームが届くまで分からない)
  // timestamp はミリ秒に丸められていて間隔が 1 ミリ秒ずれることがあるので、直近 2 つの間隔の短い方にする
  private videoFrameDuration(): number {
    const [latest, previous, before] = this.videoTimestamps;
    if (previous == null) { return 0; }
    if (before == null) { return latest - previous; }
    return Math.min(latest - previous, previous - before);
  }

  // 最初にセグメントの途中でパーシャルセグメントをいつも通りの長さで区切った時に、そのパーシャルセグメントの長さ (duration) から PART-TARGET を決める
  // (フレームが欠けたり映像が途切れたりして短く区切ったものからは決めない: flush)
  // パーシャルセグメントは PART-TARGET 以下で、INDEPENDENT=YES のものとセグメントの最後のもの以外は PART-TARGET の 85% 以上でなければならない (RFC 8216bis 4.4.4.9)
  // 映像のフレームの境目で区切るので、指定の長さのままでは 85% に届かないことがある
  // (例: 15 fps で 0.25 秒なら 3 フレーム (0.2 秒、80%) しか入らない。23.976 fps で 0.25 秒なら、6 フレーム (約 0.250 秒) は入ったり入らなかったりして、入らない時は 5 フレーム (約 0.209 秒、83%) になる)
  private decidePartialSegmentDuration(duration: number, timescale: number): void {
    const target = this.partialSegmentDuration * timescale;
    // 1 フレームだけで PART-TARGET より長いパーシャルセグメント (映像が途切れた時など) からは決めない
    // (フレームレートが低くて、1 フレームだけでも PART-TARGET より長い時は decidePartialSegmentDurationForLowFrameRate で決める)
    if (this.partialSegmentDurationDecided || duration > target) { return; }
    this.partialSegmentDurationDecided = true;

    // timestamp はミリ秒に丸められているので、同じフレーム数のパーシャルセグメントでも 1 ミリ秒長くなったり短くなったりする
    // (ここで考えるのはこの丸めによるずれだけで、timestamp がそれ以上に揺れる配信では 85% に届かないこともある)
    const margin = timescale / 1000;
    // 1 ミリ秒長くなると PART-TARGET に入らないなら、1 フレーム少ないパーシャルセグメントもできる
    // (指定の長さがちょうどフレームの長さの整数倍の時もこちら: 24 fps で 0.25 秒の 6 フレームはいつも 0.250 秒だが、
    //  6 フレームが 0.251 秒になることもある 23.976 fps とは、最初のパーシャルセグメントだけでは見分けられない)
    const frames = this.partialSegmentFrames;
    const shortest = duration + margin > target ? duration * (frames - 1) / frames : duration - margin;
    if (shortest >= 0.85 * target) { return; }
    // 85% に届かないパーシャルセグメントができるなら、いつも同じフレーム数で区切れるように、PART-TARGET をこの長さ (と 1 ミリ秒) にする
    // ただし、それまでに作ったパーシャルセグメントが PART-TARGET を超えないように、それより短くはしない
    this.partialSegmentDuration = (Math.max(duration, this.longestPartialSegment * timescale) + margin) / timescale;
  }

  // パーシャルセグメントは映像のフレームの境目で区切るので、1 フレームより短くはできない
  // フレームの間隔が PART-TARGET より長い (フレームレートが低い) と、1 フレームだけのパーシャルセグメントでも PART-TARGET を超えてしまう (RFC 8216bis 4.4.4.9)
  // そこで、直近 2 つの間隔がどちらも PART-TARGET より長ければ、PART-TARGET を 1 フレームの長さ (と timestamp の丸めの 1 ミリ秒) にする
  // (間隔が 1 つだけ長いのは映像が途切れた時などなので、配信の最初の 2 フレームの間隔だけでは決めない。2 回続けて途切れた時は見分けられないので、フレームレートが低いとみなす)
  // (1 fps 以下でどのフレームもキーフレームの映像では、セグメントが 1 フレームだけになって途中で区切ることがないので、decidePartialSegmentDuration とは別にここで決める)
  private decidePartialSegmentDurationForLowFrameRate(timescale: number): void {
    if (this.partialSegmentDurationDecided || this.videoTimestamps.length < 3) { return; }
    const frame = this.videoFrameDuration();
    if (frame <= this.partialSegmentDuration * timescale) { return; }
    this.partialSegmentDurationDecided = true;
    this.partialSegmentDuration = (frame + timescale / 1000) / timescale;
  }

  // PART-TARGET を決める前に作ったパーシャルセグメントの長さを覚えておく (decidePartialSegmentDuration で、これより短い PART-TARGET にしないため)
  // (1 フレームだけで PART-TARGET より長いもの (映像が途切れた時など) は、どのみち PART-TARGET に入らないので除く)
  private recordPartialSegment(seconds: number): void {
    if (this.partialSegmentDurationDecided || seconds > this.partialSegmentDuration) { return; }
    this.longestPartialSegment = Math.max(this.longestPartialSegment, seconds);
  }

  // 今書き込んでいるパーシャルセグメントを timestamp までで完成させて、timestamp から次のパーシャルセグメントを始める
  // now: 今届いた映像のフレームの timestamp (完成したパーシャルセグメントは、この時刻にプレイリストに追加される)
  // decide: このパーシャルセグメントの長さから PART-TARGET を決めてよいか (いつもより短く区切ったものからは決めない)
  private completePartialSegment(timestamp: number, timescale: number, now: number, decide: boolean): void {
    const segment = this.currentSegment!;
    const duration = timestamp - segment.latestBegin();
    if (decide) { this.decidePartialSegmentDuration(duration, timescale); }
    this.recordPartialSegment(duration / timescale);
    segment.partialComplete(timestamp, timescale);
    this.partialSegmentFrames = 0;
    this.addedAt = now;
    this.updated();
  }

  // 保留していた映像のフレームが end の時刻で終わると分かったので、パーシャルセグメントに入れる
  // このフレームの終わりまで入れると PART-TARGET を超えるなら、このフレームから新しいパーシャルセグメントにする
  // (パーシャルセグメントの長さは PART-TARGET 以下でなければならない: RFC 8216bis 4.4.4.9)
  private flush(end: number): void {
    const frame = this.pendingFrame;
    if (frame == null) { return; }
    this.pendingFrame = null;

    const begin = this.currentSegment?.latestBegin();
    const target = this.partialSegmentDuration * frame.timescale;
    if (begin != null && frame.timestamp > begin && end - begin > target) {
      // このフレームが 1 つ前のフレームと同じ長さ (と timestamp の丸めの 1 ミリ秒) でも入らないなら、いつも通りの長さで区切っている
      // 入ったはずなのに入らなかった時 (次のフレームが欠けた、映像が途切れた) は、このパーシャルセグメントはいつもより短いので、PART-TARGET を決めるのには使わない (次に区切った時に決める)
      const regular = this.lastFrameLength != null && frame.timestamp + this.lastFrameLength + frame.timescale / 1000 - begin > target;
      this.completePartialSegment(frame.timestamp, frame.timescale, end, regular);
    }
    for (const buffer of frame.buffers) {
      this.currentSegment?.feed(buffer, frame.keyframe);
    }
    this.partialSegmentFrames += 1;
    this.lastFrameLength = end - frame.timestamp;
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
    this.recordPartialSegment(segment.partial(segment.latestIndex())!.extinf()!);
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
    // 保留していた 1 つ前の映像のフレームは、このキーフレームの時刻で終わる
    this.flush(timestamp);
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
    this.partialSegmentFrames = 0;
    // 1 つ前のセグメントの最後のパーシャルセグメントは、このキーフレームが届いた今、プレイリストに追加した
    this.addedAt = timestamp;
    this.updated();

    if (this.segmentMap.size >= MINIMUM_LIVE_WINDOW_LENGTH) {
      // 公開したプレイリストの PART-TARGET は変えない
      this.partialSegmentDurationDecided = true;
      this.publishedNotify(true);
    }
  }

  // video: 映像のフレームか (パーシャルセグメントは、セグメントと同じく映像のフレームの境目で区切る)
  public feed(data: Iterable<Buffer>, { timestamp, timescale }: PlaylistTimestamp, video: boolean, keyframe: boolean) {
    if (this.ended) { return; }
    if (!video) {
      // 映像のフレーム以外 (音声など) は、保留している映像のフレームがあればその後ろに続ける
      for (const buffer of data) {
        if (this.pendingFrame != null) { this.pendingFrame.buffers.push(buffer); } else { this.currentSegment?.feed(buffer); }
      }
      return;
    }

    this.videoTimestamps = [timestamp, ... this.videoTimestamps].slice(0, 3);
    this.decidePartialSegmentDurationForLowFrameRate(timescale);
    // 保留していた 1 つ前の映像のフレームは、このフレームの時刻で終わる
    this.flush(timestamp);
    // パーシャルセグメントは、1 つ前のものを追加してから PART-TARGET 以内に追加しなければならない (RFC 8216bis 6.2.1)
    // パーシャルセグメントがもう PART-TARGET の長さになっていれば、このフレームはどれだけ短くても入らないので、ここで完成させる
    // そうでなくても、このフレームの終わり (次の映像のフレームが届く時) まで待つと間に合わないなら、待たずにこのフレームの前で区切る
    // (例えばセグメントの 0 番: 1 つ前のパーシャルセグメントはキーフレームが届いた時に追加したので、
    //  フレームの終わりを待ってから区切ると (flush)、必ず PART-TARGET を過ぎてから追加することになる)
    // このフレームの長さはまだ分からないので、直前のフレームの間隔から見積もる
    // (timestamp はミリ秒に丸められていて、フレームが見積もりより 1 ミリ秒長いこともあり、その時は 1 ミリ秒だけ遅れる)
    // ただし PART-TARGET を決めるまでは、見積もりでは区切らない
    // (見積もりが 1 ミリ秒長すぎて 1 フレーム手前で区切ったパーシャルセグメントから、PART-TARGET を短く決めてしまわないように。
    //  PART-TARGET はプレイリストを公開するまでには決めるので、公開した後はいつも見積もりでも区切る)
    const begin = this.currentSegment?.latestBegin();
    const target = this.partialSegmentDuration * timescale;
    const full = begin != null && timestamp - begin >= target;
    const late = this.partialSegmentDurationDecided && this.addedAt != null && timestamp + this.videoFrameDuration() - this.addedAt > target;
    if (begin != null && timestamp > begin && (full || late)) {
      this.completePartialSegment(timestamp, timescale, timestamp, true);
    }
    // data は取り出す時に MPEG-TS に変換するジェネレータで、後から取り出すと後のメッセージと順番が入れ替わるので、ここで取り出しておく
    this.pendingFrame = { timestamp, timescale, keyframe, buffers: [... data] };
  }

  // 配信の終了時に呼ぶ
  public end(): void {
    if (this.ended) { return; }
    this.ended = true;
    // 作成中のセグメントは、最後の映像のフレームの終わりまでで完成させる
    const end = this.videoTimestamps.length === 0 ? null : this.videoTimestamps[0] + this.videoFrameDuration();
    if (end != null) { this.flush(end); }
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
