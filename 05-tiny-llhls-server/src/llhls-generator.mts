import type { Writable } from 'node:stream';

import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import MPEGTSTransmuxer from '../../03-tiny-http-ts-server/src/mpegts-transmuxer.mts';
import handle_rtmp_payload, { FrameType, PacketType } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
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

// HLS (04-tiny-hls-server) と同じく MPEG-TS をキーフレームごとにセグメントに区切り、さらにパーシャルセグメントにも区切る
export default class LLHLSGenerator {
  private transmuxer = new MPEGTSTransmuxer();
  private playlist: MediaPlaylist;

  public constructor(option?: Partial<LLHLSGeneratorOption>) {
    const { liveWindowLength, partialSegmentDuration } = LLHLSGeneratorOption.from(option);
    this.playlist = new MediaPlaylist({ liveWindowLength, partialSegmentDuration });
  }

  public published(): Promise<boolean> {
    return this.playlist.published;
  }

  public stream(msn: number, part: number | null, writable: Writable, cb?: (found: boolean) => void): void {
    return this.playlist.stream(msn, part, writable, cb);
  }

  public block(msn: number, part: number | null): Promise<void> {
    return this.playlist.block(msn, part);
  }

  public m3u8(): string {
    return this.playlist.m3u8();
  }

  public end(): void {
    this.playlist.end();
  }

  public feed(message: Message): void {
    const payload = handle_rtmp_payload(message);
    const timestamp = PlaylistTimestamp.fromRTMP(message.timestamp);
    const keyframe = payload?.kind === 'Video' && payload.packetType === PacketType.CodedFrames && payload.frameType === FrameType.KEY_FRAME;
    if (keyframe) {
      // キーフレームから新しいセグメントを始める
      this.playlist.append(timestamp);
      // セグメント単体でもデコードを始められるように、セグメントの先頭に PAT/PMT/PCR を入れる
      this.transmuxer.resetPSI();
    }

    // キーフレームを含むパーシャルセグメントは単体でデコードを始められる (INDEPENDENT=YES)
    this.playlist.feed(this.transmuxer.feed(message), timestamp, keyframe);
  }
}
