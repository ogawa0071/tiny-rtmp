import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import MPEGTSTransmuxer from '../../03-tiny-http-ts-server/src/mpegts-transmuxer.mts';
import handle_rtmp_payload, { AACPacketType, FrameType, PacketType, TimestampUnwrapper } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

import MediaPlaylist from './media-playlist.mts';
import { PlaylistTimestamp } from './playlist-timestamp.mts';

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
    const message = this.timestamps.unwrap(received);
    const payload = handle_rtmp_payload(message);
    const timestamp = PlaylistTimestamp.fromRTMP(message.timestamp);
    const packets = this.transmuxer.feed(message);
    const audioOnly = !this.transmuxer.hasVideo();

    const video = !audioOnly && payload?.kind === 'Video' && payload.packetType === PacketType.CodedFrames;
    const audio = audioOnly && payload?.kind === 'Audio' && payload.packetType === AACPacketType.Raw;
    const keyframe = video && payload.frameType === FrameType.KEY_FRAME;
    const started = (keyframe || audio) && this.playlist.append(timestamp);
    if (started || keyframe) {
      this.transmuxer.resetPSI();
    }

    this.playlist.feed(packets, timestamp, video || audio);
  }
}
