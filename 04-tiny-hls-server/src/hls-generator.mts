import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import MPEGTSTransmuxer from '../../03-tiny-http-ts-server/src/mpegts-transmuxer.mts';
import handle_rtmp_payload, { AACPacketType, FrameType, PacketType, TimestampUnwrapper } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

import MediaPlaylist from './media-playlist.mts';
import { PlaylistTimestamp } from './playlist-timestamp.mts';

// HTTP-TS 配信 (03-tiny-http-ts-server) と同じ MPEG-TS を、キーフレームごとにセグメントに区切ってプレイリストで提供する
export default class HLSGenerator {
  private transmuxer = new MPEGTSTransmuxer();
  private timestamps = new TimestampUnwrapper();
  private playlist: MediaPlaylist;

  public constructor(liveWindowLength: number = 3) {
    this.playlist = new MediaPlaylist({ liveWindowLength });
  }

  public published(): Promise<boolean> {
    return this.playlist.published;
  }

  public segment(msn: number): Buffer | null {
    return this.playlist.segment(msn);
  }

  public m3u8(): string {
    return this.playlist.m3u8();
  }

  public end(): void {
    this.playlist.end();
  }

  public feed(received: Message): void {
    // RTMP の timestamp が一周して戻っても (rtmp-handler.mts の TimestampUnwrapper)、時刻が戻らないように直してから使う
    const message = this.timestamps.unwrap(received);
    const payload = handle_rtmp_payload(message);
    const timestamp = PlaylistTimestamp.fromRTMP(message.timestamp);
    // 先にこのメッセージを渡して、映像 (AVC) のない配信か (PMT に AVC の ES を載せないか) を決めさせる (MPEGTSTransmuxer の hasVideo)
    // (TS パケットにするのは、下でセグメントの先頭にするかを決めてから、playlist.feed で取り出す時なので、PAT/PMT はその時に入る)
    const packets = this.transmuxer.feed(message);
    // 映像のない配信 (音声だけの配信や、このサーバで扱えない AVC 以外の映像の配信) か
    // onMetaData を送ってこない配信ソフトや、onMetaData にコーデックを書かない配信ソフト (yasea など) では、映像が届くまで分からないので、映像のキーフレームを待つ
    // (映像が音声より遅れて届くこともあり、音声だけで区切ったセグメントの後から映像が始まると、そこから再生を始めたプレイヤーは映像を再生できない)
    // onMetaData に書かれていなかった映像が、音声を TS パケットにし始めた後から届いても使わない (MPEGTSTransmuxer の hasVideo)
    // (トラックを増やす所には EXT-X-DISCONTINUITY が必要で (RFC 8216 4.3.2.3)、再生を始めたプレイヤーは途中からトラックを増やせない)
    const audioOnly = !this.transmuxer.hasVideo();

    // キーフレームから新しいセグメントを始める
    // 映像のない配信では、音声のフレームから (1 秒以上たったら) 新しいセグメントを始める (AAC のフレームはどれも単体でデコードできる)
    const video = !audioOnly && payload?.kind === 'Video' && payload.packetType === PacketType.CodedFrames;
    const audio = audioOnly && payload?.kind === 'Audio' && payload.packetType === AACPacketType.Raw;
    const keyframe = video && payload.frameType === FrameType.KEY_FRAME;
    const started = (keyframe || audio) && this.playlist.append(timestamp);
    // セグメント単体でもデコードを始められるように、セグメントの先頭に PAT/PMT を入れる
    // セグメントの途中のキーフレームの前にも入れる (FFmpeg の MPEG-TS も、映像のキーフレームの前には PAT/PMT を入れる)
    // (映像のない配信では、音声のフレームごとに入れると多すぎるので、セグメントの先頭だけにする)
    if (started || keyframe) {
      this.transmuxer.resetPSI();
    }

    // 配信が終わった時は、セグメントを区切るフレーム (映像のない配信では音声のフレーム) の最後のものの時刻までで、最後のセグメントを完成させる
    this.playlist.feed(packets, timestamp, video || audio);
  }
}
