import crypto from 'node:crypto';

import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import { read_audio_specific_config } from '../../03-tiny-http-ts-server/src/aac.mts';
import handle_rtmp_payload, { AACPacketType, FrameType, PacketType, read_onmetadata } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
import { read_avc_decoder_configuration_record } from '../../03-tiny-http-ts-server/src/avc.mts';

import { initialize, make } from '../../06-tiny-http-fmp4-server/src/fmp4.mts';

import SegmentTimeline from '../../07-tiny-dash-server/src/segment-timeline.mts';
import { serializeXML, XMLNode } from '../../07-tiny-dash-server/src/xml.mts';
import { aacMimeTypeCodec, avcMimeTypeCodec } from '../../07-tiny-dash-server/src/mimetype.mts';

import { encrypt_avc, read_parameter_sets, write_mp4_avc_track_information, type ParameterSets } from './avc.mts';
import { encrypt_aac, write_mp4_aac_track_information } from './aac.mts';
import { EncryptionFormat, EncryptionScheme, fragment, IVType, pssh } from './cenc.mts';

type VideoInformation = {
  type: number;
  dts: number;
  cto: number;
  data: Buffer;
};

const RTMP_TIMESCALE = 1000;
const AAC_SAMPLES_PER_FRAME = 1024;
const COMMON_SYSTEM_ID = Buffer.from('1077efec-c0b2-4d02-ace3-3c1e52e2fb4b'.replaceAll('-', ''), 'hex'); // W3C Common PSSH (Clear Key で使う)

export default class DASHGenerator {
  private avcDecoderConfigurationRecord: Buffer | null = null;
  private parameterSets: ParameterSets | null = null; // slice_header を読むのに使う SPS/PPS (映像データの中で送られてきたものも含む)
  private audioSpecificConfig: Buffer | null = null;
  private onMetadata: AMF0Object | null = null;

  private previousVideoInformation: VideoInformation | null = null;
  private aacLatestTimestamp: number | null = null;
  // 映像を区切ったので、次に届く音声フレームから音声も新しいセグメントにする
  private audioCutPending = false;
  // moof の sequence_number (Representation ごとに 1 から増やす)
  private videoSequenceNumber = 0;
  private audioSequenceNumber = 0;

  private liveWindowLength: number;
  private videoTimeline: SegmentTimeline | null = null;
  private audioTimeline: SegmentTimeline | null = null;

  private encryptionFormat: EncryptionFormat;
  private ivSize: number;
  private ivType: IVType;
  private keyId: Buffer;
  private key: Buffer;

  // availabilityStartTime は RTMP の timestamp が 0 になる時刻 (最初のメディアが届いた時に決める)
  private availabilityStartTime: Temporal.Instant | null = null;
  // 配信ごとに変わる値 (配信をやり直すと同じ URL で中身が変わらないように、セグメントの URL に含める)
  // (初期化セグメントには暗号化の IV なども入るので、前の配信のものがキャッシュから使われると復号できない)
  public readonly session = `${Date.now()}`;

  public constructor(format: EncryptionFormat, keyId: Buffer, key: Buffer, liveWindowLength: number = 3) {
    this.liveWindowLength = liveWindowLength;
    this.encryptionFormat = format;
    this.ivSize = this.encryptionFormat.bytes;
    // cenc (AES-CTR) はサンプルごとに乱数で作った IV (Per-Sample IV) を使い、senc に書く
    // cbcs (AES-CBC) は全てのサンプルで同じ IV (Constant IV) を使い、tenc に書く (cbcs を使う Apple や Firefox などは Constant IV を前提にしている)
    this.ivType = format.scheme === EncryptionScheme.CENC ? {
      type: IVType.PER_SAMPLE,
      per_sample_iv_size: this.ivSize,
    } : {
      type: IVType.CONSTANT,
      constant_iv: crypto.randomBytes(this.ivSize),
    };
    this.keyId = keyId;
    this.key = key;
  }

  // 暗号化されていることと、その方式 (cenc/cbcs) と鍵の ID (tenc の default_KID と同じ) を示す (DASH-IF IOP 7.7.2)
  private mp4protection(): XMLNode {
    const kid = this.keyId.toString('hex');
    return XMLNode.from('ContentProtection', {
      schemeIdUri: 'urn:mpeg:dash:mp4protection:2011',
      value: this.encryptionFormat.scheme,
      'cenc:default_KID': `${kid.slice(0, 8)}-${kid.slice(8, 12)}-${kid.slice(12, 16)}-${kid.slice(16, 20)}-${kid.slice(20)}`,
    });
  }

  // 配信の映像が、このサーバで扱える AVC か (onMetaData の videocodecid で判断する)
  // (コーデックを数値ではなく 'avc1' の文字列で送ってくる配信ソフトもある)
  private hasVideo(): boolean {
    return this.onMetadata?.videocodecid === 7 || this.onMetadata?.videocodecid === 'avc1';
  }

  // 配信の音声が、このサーバで扱える AAC か (onMetaData の audiocodecid で判断する)
  // (コーデックを数値ではなく 'mp4a' の文字列で送ってくる配信ソフトもある)
  private hasAudio(): boolean {
    return this.onMetadata?.audiocodecid === 10 || this.onMetadata?.audiocodecid === 'mp4a';
  }

  // MPD を作る (まだ MPD に載せられるセグメントがなければ null)
  public mpd(): string | null {
    // SegmentTimeline には S が 1 つ以上必要なので、onMetaData に書かれた (このサーバで扱える) 全てのトラックにセグメントができるまでは MPD を作らない
    // (トラックを後から MPD に足しても再生を始めたプレイヤーには使われないので、初期化情報が遅れて届くトラックも待つ)
    if (!this.hasVideo() && !this.hasAudio()) { return null; }
    if (this.hasVideo() && !(this.videoTimeline?.hasSegments() ?? false)) { return null; }
    if (this.hasAudio() && !(this.audioTimeline?.hasSegments() ?? false)) { return null; }

    const declaration = '<?xml version="1.0" encoding="UTF-8"?>';

    const mpd = XMLNode.from('MPD', {
      xmlns: 'urn:mpeg:dash:schema:mpd:2011',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xmlns:cenc': 'urn:mpeg:cenc:2013',
      'xmlns:clearkey': 'http://dashif.org/guidelines/clearKey',
      'xsi:schemaLocation': 'urn:mpeg:dash:schema:mpd:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd',
      profiles: 'urn:mpeg:dash:profile:isoff-live:2011',
      type: 'dynamic',
      availabilityStartTime: (this.availabilityStartTime ?? Temporal.Now.instant()).toString({ smallestUnit: 'millisecond' }),
      publishTime: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
      minimumUpdatePeriod: 'PT1S',
      minBufferTime: 'PT2S',
    });
    // type="dynamic" の MPD では Period@id が必須
    const period = XMLNode.from('Period', { id: '0', start: 'PT0S' });
    // Clear Key で復号できることを示す (Clear Key の初期化データは cenc:default_KID から作られる)
    const clearkey_protection = XMLNode.from('ContentProtection', {
      schemeIdUri: 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e',
      value: 'ClearKey1.0',
    });

    if (this.hasVideo() && this.avcDecoderConfigurationRecord != null && this.videoTimeline != null) {
      const avcDecoderConfigurationRecord = read_avc_decoder_configuration_record(this.avcDecoderConfigurationRecord);
      const video_adaptationset = XMLNode.from('AdaptationSet', {
        contentType: 'video',
        mimeType: 'video/mp4',
      });

      video_adaptationset.children.push(this.mp4protection(), clearkey_protection);

      const video_representation = XMLNode.from('Representation', {
        id: '1',
        codecs: avcMimeTypeCodec(avcDecoderConfigurationRecord),
        bandwidth: `${this.videoTimeline.bandwidth()}`, // Representation@bandwidth は必須
      });

      video_representation.children.push(this.videoTimeline.segment_template());
      video_adaptationset.children.push(video_representation);
      period.children.push(video_adaptationset);
    }

    if (this.hasAudio() && this.audioSpecificConfig != null && this.audioTimeline != null) {
      const audioSpecificConfig = read_audio_specific_config(this.audioSpecificConfig);
      const audio_adaptationset = XMLNode.from('AdaptationSet', {
        contentType: 'audio',
        mimeType: 'audio/mp4',
      });
      audio_adaptationset.children.push(this.mp4protection(), clearkey_protection);

      const audio_representation = XMLNode.from('Representation', {
        id: '2',
        codecs: aacMimeTypeCodec(audioSpecificConfig),
        bandwidth: `${this.audioTimeline.bandwidth()}`, // Representation@bandwidth は必須
      });
      audio_representation.children.push(this.audioTimeline.segment_template());
      audio_adaptationset.children.push(audio_representation);
      period.children.push(audio_adaptationset);
    }

    mpd.children.push(period);

    return declaration + '\n' + serializeXML(mpd);
  }

  public segment(type: string, msn: number): Buffer | null {
    switch (type) {
      case 'video': return this.videoTimeline?.segment(msn) ?? null;
      case 'audio': return this.audioTimeline?.segment(msn) ?? null;
      default: return null;
    }
  }

  public initialize(type: string): Buffer | null {
    switch (type) {
      case 'video': return this.videoTimeline?.initialize() ?? null;
      case 'audio': return this.audioTimeline?.initialize() ?? null;
      default: return null;
    }
  }

  public feed(message: Message): void {
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return; }

    // 初期化セグメントに必要な情報を集める
    switch (payload.kind) {
      case 'Video':
        if (payload.packetType === PacketType.SequenceStart) {
          this.avcDecoderConfigurationRecord = payload.avcDecoderConfigurationRecord;
          this.parameterSets = read_parameter_sets(read_avc_decoder_configuration_record(payload.avcDecoderConfigurationRecord));
          return;
        }
        break;
      case 'Audio':
        if (payload.packetType === AACPacketType.SequenceHeader) {
          this.audioSpecificConfig = payload.audioSpecificConfig;
          return;
        }
        break;
      case 'Data': {
        const metadata = read_onmetadata(payload.values);
        if (metadata != null) { this.onMetadata = metadata; }
        return;
      }
    }

    if (this.onMetadata == null) { return; }
    // RTMP の timestamp は 0 から始まるとは限らないので、timestamp が 0 になる時刻を availabilityStartTime にする
    this.availabilityStartTime ??= Temporal.Now.instant().subtract({ milliseconds: payload.timestamp });

    // 初期化情報が揃ったトラックから、初期化セグメントを作ってセグメントを並べ始める

    if (this.hasVideo() && this.avcDecoderConfigurationRecord != null && this.videoTimeline == null) {
      const initialization = make((vector) => {
        initialize(RTMP_TIMESCALE, [1], vector, (vector) => {
          vector.write(write_mp4_avc_track_information(1, RTMP_TIMESCALE, this.encryptionFormat, this.ivType, this.keyId, this.avcDecoderConfigurationRecord!));
          pssh(COMMON_SYSTEM_ID, [this.keyId], Buffer.from([]), vector);
        });
      });
      this.videoTimeline = new SegmentTimeline(`video_${this.session}`, RTMP_TIMESCALE, initialization, { liveWindowLength: this.liveWindowLength });
    }
    if (this.hasAudio() && this.audioSpecificConfig != null && this.audioTimeline == null) {
      const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
      const initialization = make((vector) => {
        initialize(samplingFrequency, [1], vector, (vector) => {
          vector.write(write_mp4_aac_track_information(1, samplingFrequency, this.encryptionFormat, this.ivType, this.keyId, this.audioSpecificConfig!));
          pssh(COMMON_SYSTEM_ID, [this.keyId], Buffer.from([]), vector);
        });
      });
      this.audioTimeline = new SegmentTimeline(`audio_${this.session}`, samplingFrequency, initialization, { liveWindowLength: this.liveWindowLength });
    }

    switch (payload.kind) {
      case 'Video': {
        if (this.videoTimeline == null) { return; }
        if (this.avcDecoderConfigurationRecord == null) { return; }
        // フレームの長さ (duration) は次のフレームとの差でわかるので、1 つ前のフレームをここで書き出す
        if (this.previousVideoInformation != null) {
          const avcDecoderConfigurationRecord = read_avc_decoder_configuration_record(this.avcDecoderConfigurationRecord);
          const { type, dts, cto, data } = this.previousVideoInformation;
          const duration = Math.max(0, payload.timestamp - dts); // timestamp が戻っても負の長さにしない
          this.videoTimeline.feed(make((vector) => {
            const iv = this.ivType.type === IVType.CONSTANT ? this.ivType.constant_iv : crypto.randomBytes(this.ivSize);
            const [encrypted, subsample] = encrypt_avc(this.encryptionFormat, this.key, iv, data, avcDecoderConfigurationRecord, this.parameterSets!);

            fragment(
              { sequence_number: ++this.videoSequenceNumber, track_id: 1, keyframe: type === FrameType.KEY_FRAME, duration, dts, cto },
              { iv, subsamples: subsample },
              this.ivType.type,
              encrypted,
              vector
            );
          }));
        }
        // 1 つ前のフレームを今のセグメントに書き出してから、キーフレームで新しいセグメントを始める
        // 映像を区切った時は音声も区切る (次に届く音声フレームから新しいセグメントに入れる)
        if (payload.frameType === FrameType.KEY_FRAME && this.videoTimeline.append(payload.timestamp)) {
          this.audioCutPending = true;
        }
        this.previousVideoInformation = {
          type: payload.frameType,
          dts: payload.timestamp,
          cto: payload.compositionTimeOffset,
          data: payload.data,
        };
        return;
      }
      case 'Audio': {
        if (this.audioTimeline == null) { return; }
        if (this.audioSpecificConfig == null) { return; }
        // AAC は 1 フレームが 1024 サンプルなので、前のフレームから 1024 ずつ進める
        // ただし音声が途切れた時などに RTMP の timestamp と 1 フレーム以上ずれたら、RTMP の timestamp に合わせ直す
        const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
        const timestamp = Math.floor(payload.timestamp * samplingFrequency / 1000);
        if (this.aacLatestTimestamp == null) {
          // 最初の音声フレームからセグメントを始める (映像のキーフレームを待つと、それまでの音声が捨てられる)
          this.audioTimeline.append(timestamp);
        }
        if (this.aacLatestTimestamp == null || Math.abs(this.aacLatestTimestamp + AAC_SAMPLES_PER_FRAME - timestamp) > AAC_SAMPLES_PER_FRAME) {
          this.aacLatestTimestamp = timestamp;
        } else {
          this.aacLatestTimestamp += AAC_SAMPLES_PER_FRAME;
        }
        const dts = this.aacLatestTimestamp;
        // 映像を区切った後の最初の音声フレームから、音声も新しいセグメントにする
        // (区切るのをこのフレームの時刻にすれば、音声が途切れた後でもセグメントの開始時刻 S@t と最初のフレームの時刻が一致する)
        // 音声のフレームの区切りは映像と揃わず 1 秒より少し短くなることがあるので、最小の長さは確認しない
        if (this.audioCutPending) {
          this.audioTimeline.append(dts, true);
          this.audioCutPending = false;
        }
        // 映像がない (またはこのサーバで扱えない AVC 以外の映像の) 配信では、音声だけで (1 秒以上たったら) セグメントを区切る
        if (!this.hasVideo()) { this.audioTimeline.append(dts); }
        this.audioTimeline.feed(make((vector) => {
          const iv = this.ivType.type === IVType.CONSTANT ? this.ivType.constant_iv : crypto.randomBytes(this.ivSize);
          const [encrypted, subsample] = encrypt_aac(this.encryptionFormat, this.key, iv, payload.data);

          fragment(
            { sequence_number: ++this.audioSequenceNumber, track_id: 1, keyframe: true, duration: AAC_SAMPLES_PER_FRAME, dts, cto: 0 },
            { iv, subsamples: subsample },
            this.ivType.type,
            encrypted,
            vector
          );
        }));
        return;
      }
    }
  }
}
