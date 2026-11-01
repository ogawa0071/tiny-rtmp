import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import MPEGTSTransmuxer from '../../03-tiny-http-ts-server/src/mpegts-transmuxer.mts';
import handle_rtmp_payload, { AACPacketType, FrameType, PacketType, read_onmetadata, TimestampUnwrapper, VideoCodecType } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

import MediaPlaylist from './media-playlist.mts';
import { PlaylistTimestamp } from './playlist-timestamp.mts';

// HTTP-TS 配信 (03-tiny-http-ts-server) と同じ MPEG-TS を、キーフレームごとにセグメントに区切ってプレイリストで提供する
export default class HLSGenerator {
  private transmuxer = new MPEGTSTransmuxer();
  private timestamps = new TimestampUnwrapper();
  private playlist: MediaPlaylist;
  // 映像 (AVC) のない配信か (音声だけの配信や、このサーバで扱えない AVC 以外の映像の配信)
  private audioOnly = false;

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
    // onMetaData に音声のコーデックが書かれていて、AVC が書かれていなければ、映像のない配信とする (コーデックを 'avc1' の文字列で送ってくる配信ソフトもある)
    // onMetaData を送ってこない配信ソフトや、onMetaData にコーデックを書かない配信ソフト (yasea など) では分からないので、映像のキーフレームを待つ
    // (映像が音声より遅れて届くこともあり、音声だけで区切ったセグメントの後から映像が始まると、そこから再生を始めたプレイヤーは映像を再生できない)
    const metadata = payload?.kind === 'Data' ? read_onmetadata(payload.values) : null;
    if (metadata?.audiocodecid != null) {
      this.audioOnly = metadata.videocodecid !== VideoCodecType.AVC && metadata.videocodecid !== 'avc1';
    }
    // AVC の映像が届いたら、映像のキーフレームで区切る
    if (payload?.kind === 'Video') { this.audioOnly = false; }
    // 映像のない配信では、PMT にも音声だけを載せる (届かない映像を待ってしまうプレイヤーがある)
    this.transmuxer.audioOnly = this.audioOnly;

    // キーフレームから新しいセグメントを始める
    // 映像のない配信では、音声のフレームから (1 秒以上たったら) 新しいセグメントを始める (AAC のフレームはどれも単体でデコードできる)
    const video = payload?.kind === 'Video' && payload.packetType === PacketType.CodedFrames;
    const audio = this.audioOnly && payload?.kind === 'Audio' && payload.packetType === AACPacketType.Raw;
    const keyframe = video && payload.frameType === FrameType.KEY_FRAME;
    const started = (keyframe || audio) && this.playlist.append(timestamp);
    // セグメント単体でもデコードを始められるように、セグメントの先頭に PAT/PMT を入れる
    // セグメントの途中のキーフレームの前にも入れる (FFmpeg の MPEG-TS も、映像のキーフレームの前には PAT/PMT を入れる)
    // (映像のない配信では、音声のフレームごとに入れると多すぎるので、セグメントの先頭だけにする)
    if (started || keyframe) {
      this.transmuxer.resetPSI();
    }

    // 配信が終わった時は、セグメントを区切るフレーム (映像のない配信では音声のフレーム) の最後のものの時刻までで、最後のセグメントを完成させる
    this.playlist.feed(this.transmuxer.feed(message), timestamp, video || audio);
  }
}
