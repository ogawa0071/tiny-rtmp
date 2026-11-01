import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import MPEGTSTransmuxer from '../../03-tiny-http-ts-server/src/mpegts-transmuxer.mts';
import handle_rtmp_payload, { AACPacketType, FrameType, PacketType, read_onmetadata, TimestampUnwrapper, VideoCodecType } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
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
  private timestamps = new TimestampUnwrapper();
  private playlist: MediaPlaylist;
  // 映像 (AVC) のない配信か (音声だけの配信や、このサーバで扱えない AVC 以外の映像の配信)
  private audioOnly = false;

  public constructor(option?: Partial<LLHLSGeneratorOption>) {
    const { liveWindowLength, partialSegmentDuration } = LLHLSGeneratorOption.from(option);
    // セグメントの途中で新しいパーシャルセグメントを始めた時も、その先頭に PAT/PMT を入れる
    // (MPEG-TS のパーシャルセグメントも PAT と PMT を含み、先頭の 2 つのパケットは PAT と PMT にする: RFC 8216bis 3.2, 3.1.1。
    //  INDEPENDENT=YES のパーシャルセグメントから再生を始める視聴者も、その PAT/PMT から読み始められる)
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
    // RTMP の timestamp が一周して戻っても (rtmp-handler.mts の TimestampUnwrapper)、時刻が戻らないように直してから使う
    const message = this.timestamps.unwrap(received);
    const payload = handle_rtmp_payload(message);
    const timestamp = PlaylistTimestamp.fromRTMP(message.timestamp);
    // 映像のない配信かは、HLS (04-tiny-hls-server) と同じく onMetaData で決める (AVC の映像が届いたら、映像のある配信として扱う)
    const metadata = payload?.kind === 'Data' ? read_onmetadata(payload.values) : null;
    if (metadata?.audiocodecid != null) {
      this.audioOnly = metadata.videocodecid !== VideoCodecType.AVC && metadata.videocodecid !== 'avc1';
    }
    if (payload?.kind === 'Video') { this.audioOnly = false; }
    // 映像のない配信では、PMT にも音声だけを載せる (HLS (04-tiny-hls-server) と同じ)
    this.transmuxer.audioOnly = this.audioOnly;

    const video = payload?.kind === 'Video' && payload.packetType === PacketType.CodedFrames;
    const keyframe = video && payload.frameType === FrameType.KEY_FRAME;
    // 映像のない配信では、音声のフレームを映像のキーフレームの代わりにして (パーシャル) セグメントを区切る
    // (AAC のフレームはどれも単体でデコードできる。セグメントは 1 秒以上たったら区切る)
    const audio = this.audioOnly && payload?.kind === 'Audio' && payload.packetType === AACPacketType.Raw;
    // キーフレームから新しいセグメントを始める
    const started = (keyframe || audio) && this.playlist.append(timestamp);
    // セグメント単体でもデコードを始められるように、セグメントの先頭に PAT/PMT を入れる
    // セグメントの途中のキーフレームの前にも入れる (FFmpeg の MPEG-TS も、映像のキーフレームの前には PAT/PMT を入れる)
    // (映像のない配信では、音声のフレームごとに入れると多すぎるので、セグメントの先頭だけにする。パーシャルセグメントの先頭には MediaPlaylist が入れる)
    if (started || keyframe) {
      this.transmuxer.resetPSI();
    }

    // キーフレームを含むパーシャルセグメントは単体でデコードを始められる (INDEPENDENT=YES)
    this.playlist.feed(this.transmuxer.feed(message), timestamp, video || audio, keyframe || audio);
  }
}
