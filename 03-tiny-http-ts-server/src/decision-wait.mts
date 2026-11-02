import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import type MPEGTSTransmuxer from './mpegts-transmuxer.mts';

// 配信の始めに、PMT に載せる ES が決まるのを待つ長さ (最初の映像・音声のメッセージの timestamp からのミリ秒) と、その間に溜めるメッセージの数の上限
// (onMetaData を送ってこない配信で、届かないトラックがある時などはいつまでも決まらないので、ずっとは待たない。06 の UNDECLARED_TRACK_WAIT, MAX_WAITING_FRAMES と同じ)
export const DECISION_WAIT = 1000;
export const MAX_PENDING_MESSAGES = 1000;

// 送れるようになった TS パケット (released は、配信の始めに待っていた間の分を、ここでまとめて返したか)
export type Output = { packets: Buffer[]; released: boolean; };

// HTTP-TS 配信 (index.mts) で、配信の始めは PMT に載せる ES が決まるまで (MPEGTSTransmuxer の decided)、feed が返したもの (取り出す時に TS パケットにする) を溜めておく
// (PAT/PMT は取り出す時に出力するので、決まってから順に取り出すと、最初の PMT から決まった ES だけが載る。FFmpeg も、入力を調べてから PMT を決める。
//  決まる前に出力した PMT に、後から載せないと分かった ES が載っていると、version_number を増やした PMT で外しても、mpegts.js などはその ES のデータを待って再生を始めない)
export default class DecisionWait {
  private transmuxer: MPEGTSTransmuxer;
  // feed が返したもので、まだ取り出していないもの
  private pending: Iterable<Buffer>[] = [];
  // まだ待っているか
  private waiting = true;
  // 最初の映像・音声のメッセージの timestamp (待った長さを測る)
  private first: number | null = null;

  public constructor(transmuxer: MPEGTSTransmuxer) {
    this.transmuxer = transmuxer;
  }

  // RTMP のメッセージを MPEGTSTransmuxer に渡して、送れるようになった TS パケットを返す
  public feed(message: Message): Output {
    this.pending.push(this.transmuxer.feed(message));
    if (this.waiting) {
      // 待った長さは映像・音声のメッセージの timestamp で測る (onMetaData の timestamp は、映像・音声と同じ時計とは限らない)
      let waited = false;
      if (message.message_type_id === MessageType.Video || message.message_type_id === MessageType.Audio) {
        this.first ??= message.timestamp;
        waited = message.timestamp - this.first >= DECISION_WAIT;
      }
      // ES が決まるか、DECISION_WAIT だけ待つか、MAX_PENDING_MESSAGES 個溜まるまで待つ
      if (!this.transmuxer.decided() && !waited && this.pending.length < MAX_PENDING_MESSAGES) { return { packets: [], released: false }; }
    }
    return this.flush();
  }

  // 溜めていたものから順に TS パケットにして返す (ES が決まる前に配信が終わった時も、溜めていた分を返す)
  public flush(): Output {
    const packets = this.pending.splice(0).flatMap((iterable) => [... iterable]);
    const released = this.waiting;
    this.waiting = false;
    return { packets, released };
  }
}
