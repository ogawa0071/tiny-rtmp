import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import MPEGTSTransmuxer from '../../03-tiny-http-ts-server/src/mpegts-transmuxer.mts';
import handle_rtmp_payload, { AACPacketType, FrameType, PacketType, TimestampUnwrapper } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';

import MediaPlaylist from './media-playlist.mts';

export type LLHLSGeneratorOption = {
  liveWindowLength: number;
  partialSegmentDuration: number;
};

export const LLHLSGeneratorOption = {
  from(option?: Partial<LLHLSGeneratorOption>): LLHLSGeneratorOption {
    return {
      liveWindowLength: option?.liveWindowLength ?? 3,
      partialSegmentDuration: option?.partialSegmentDuration ?? 1,
    };
  },
};

export default class LLHLSGenerator {
  private transmuxer = new MPEGTSTransmuxer();
  private timestamps = new TimestampUnwrapper();
  private playlist: MediaPlaylist;

  public constructor(option?: Partial<LLHLSGeneratorOption>) {
    const { liveWindowLength, partialSegmentDuration } = LLHLSGeneratorOption.from(option);
    this.playlist = new MediaPlaylist({ liveWindowLength, partialSegmentDuration }, () => { this.transmuxer.resetPSI(); });
  }

  public published(): Promise<boolean> {
    return this.playlist.published;
  }

  public get(msn: number, part: number | null): Promise<Buffer | null> {
    return this.playlist.get(msn, part);
  }

  public tooFar(msn: number, part: number | null): boolean {
    return this.playlist.tooFar(msn, part);
  }

  public block(msn: number, part: number | null): Promise<boolean> {
    return this.playlist.block(msn, part);
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
    const keyframe = video && payload.frameType === FrameType.KEY_FRAME;
    const audio = audioOnly && payload?.kind === 'Audio' && payload.packetType === AACPacketType.Raw;
    const started = (keyframe || audio) && this.playlist.append(timestamp);
    if (started || keyframe) {
      this.transmuxer.resetPSI();
    }

    this.playlist.feed(packets, timestamp, video || audio, keyframe || audio);
  }
}
