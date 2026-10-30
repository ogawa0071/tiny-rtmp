import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import MPEGTSTransmuxer from '../../03-tiny-http-ts-server/src/mpegts-transmuxer.mts';
import handle_rtmp_payload, { FrameType, PacketType } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

import MediaPlaylist from './media-playlist.mts';
import { PlaylistTimestamp } from './playlist-timestamp.mts';

// HTTP-TS 配信 (03-tiny-http-ts-server) と同じ MPEG-TS を、キーフレームごとにセグメントに区切ってプレイリストで提供する
export default class HLSGenerator {
  private transmuxer = new MPEGTSTransmuxer();
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

  public feed(message: Message): void {
    const payload = handle_rtmp_payload(message);
    if (payload?.kind === 'Video' && payload.packetType === PacketType.CodedFrames && payload.frameType === FrameType.KEY_FRAME) {
      // キーフレームから新しいセグメントを始める
      this.playlist.append(PlaylistTimestamp.fromRTMP(payload.timestamp));
      // セグメント単体でもデコードを始められるように、セグメントの先頭に PAT/PMT/PCR を入れる
      this.transmuxer.resetPSI();
    }

    this.playlist.feed(this.transmuxer.feed(message));
  }
}
