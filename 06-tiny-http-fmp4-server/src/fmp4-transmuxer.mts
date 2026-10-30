import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import { read_audio_specific_config } from '../../03-tiny-http-ts-server/src/aac.mts';
import handle_rtmp_payload, { AACPacketType, FrameType, PacketType, read_onmetadata } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

import { write_mp4_aac_track_information } from './aac.mts';
import { fragment, initialize, make } from './fmp4.mts';
import { write_mp4_avc_track_information } from './avc.mts';

type VideoInformation = {
  type: number;
  dts: number;
  cto: number;
  data: Buffer;
};

const RTMP_TIMESCALE = 1000;
const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;

export default class FMP4Transmuxer {
  private avcDecoderConfigurationRecord: Buffer | null = null;
  private audioSpecificConfig: Buffer | null = null;
  private onMetadata: AMF0Object | null = null;

  private initializeSegment: Buffer | null = null;
  private previousVideoInformation: VideoInformation | null = null;
  private aacLatestTimestamp: number | null = null;

  public initialize(): Buffer | null {
    return this.initializeSegment;
  }

  // onMetaData に書かれている全てのコーデックの初期化情報が揃ったら、初期化セグメント (ftyp + moov) を作る
  private create_initialize_segment(): Buffer | null {
    if (this.onMetadata == null) { return null; }

    const tracks = new Map<number, Buffer>();
    if (this.onMetadata.videocodecid != null) {
      if (this.avcDecoderConfigurationRecord == null) { return null; }
      tracks.set(VIDEO_TRACK_ID, write_mp4_avc_track_information(VIDEO_TRACK_ID, RTMP_TIMESCALE, this.avcDecoderConfigurationRecord));
    }
    if (this.onMetadata.audiocodecid != null) {
      if (this.audioSpecificConfig == null) { return null; }
      const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
      tracks.set(AUDIO_TRACK_ID, write_mp4_aac_track_information(AUDIO_TRACK_ID, samplingFrequency, this.audioSpecificConfig));
    }

    return make((vector) => {
      initialize(RTMP_TIMESCALE, [... tracks.keys()], vector, (vector) => {
        for (const track of tracks.values()) { vector.write(track); }
      });
    });
  }

  public feed(message: Message): Buffer | null {
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return null; }

    // 初期化セグメントに必要な情報を集める
    switch (payload.kind) {
      case 'Video':
        if (payload.packetType === PacketType.SequenceStart) {
          this.avcDecoderConfigurationRecord = payload.avcDecoderConfigurationRecord;
          return null;
        }
        break;
      case 'Audio':
        if (payload.packetType === AACPacketType.SequenceHeader) {
          this.audioSpecificConfig = payload.audioSpecificConfig;
          return null;
        }
        break;
      case 'Data': {
        const metadata = read_onmetadata(payload.values);
        if (metadata != null) { this.onMetadata = metadata; }
        return null;
      }
    }

    this.initializeSegment ??= this.create_initialize_segment();
    if (this.initializeSegment == null) { return null; }

    switch (payload.kind) {
      case 'Video': {
        if (this.avcDecoderConfigurationRecord == null) { return null; }
        // フレームの長さ (duration) は次のフレームとの差でわかるので、1 つ前のフレームをここで書き出す
        const previous = this.previousVideoInformation;
        this.previousVideoInformation = {
          type: payload.frameType,
          dts: payload.timestamp,
          cto: payload.compositionTimeOffset,
          data: payload.data,
        };
        if (previous == null) { return null; }

        const { type, dts, cto, data } = previous;
        const duration = payload.timestamp - dts;
        return make((vector) => {
          fragment({ track_id: VIDEO_TRACK_ID, keyframe: type === FrameType.KEY_FRAME, duration, dts, cto }, data, vector);
        });
      }
      case 'Audio': {
        if (this.audioSpecificConfig == null) { return null; }
        // AAC は 1 フレームが 1024 サンプルなので、最初のフレームの timestamp から 1024 ずつ進める
        if (this.aacLatestTimestamp == null) {
          const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
          this.aacLatestTimestamp = Math.floor(payload.timestamp * samplingFrequency / 1000);
        } else {
          this.aacLatestTimestamp += 1024;
        }
        const dts = this.aacLatestTimestamp;
        return make((vector) => {
          fragment({ track_id: AUDIO_TRACK_ID, keyframe: true, duration: 1024, dts, cto: 0 }, payload.data, vector);
        });
      }
    }
  }
}
