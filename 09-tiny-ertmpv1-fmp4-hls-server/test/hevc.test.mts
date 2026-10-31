import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import { read_nal_unit_length_size, strip_parameter_sets, write_mp4_hevc_track_information } from '../src/hevc.mts';
import HLSGenerator from '../src/hls-generator.mts';

// NAL Unit を長さ (lengthSize byte) + NAL Unit で並べる
const sized = (lengthSize: number, ... nalus: string[]): Buffer => {
  return Buffer.concat(nalus.map((hex) => {
    const nalu = Buffer.from(hex, 'hex');
    const length = Buffer.alloc(lengthSize);
    length.writeUIntBE(nalu.byteLength, 0, lengthSize);
    return Buffer.concat([length, nalu]);
  }));
};

// NAL Unit Header (2 byte) の先頭: nal_unit_type << 1 (VPS/SPS/PPS は x265 の 640x360 のもの)
const VPS = '40010c01ffff01600000030090000003000003003f959409';
const SPS = '42010101600000030090000003000003003fa005020171f2e595952930bc05a020000003002000000303c1';
const PPS = '4401c073c189';
const AUD = '460150';
const SEI = '4e01dd';
const IDR = '2801ee'; // IDR_N_LP (20)
const TRAIL = '0201ff'; // TRAIL_R (1)

// 最小限の HEVCDecoderConfigurationRecord: 固定長の部分 (22 byte) + numOfArrays + 配列 (VPS/SPS/PPS は array_completeness 0、SEI は 1 で送られてきたもの)
const record = (lengthSizeMinusOne: number): Buffer => {
  const fixed = Buffer.alloc(22);
  fixed[0] = 1; // configurationVersion
  fixed[21] = 0b11111100 | lengthSizeMinusOne; // constantFrameRate, numTemporalLayers, temporalIdNested, lengthSizeMinusOne
  const array = (type: number, hex: string) => {
    const nalu = Buffer.from(hex, 'hex');
    return Buffer.concat([Buffer.from([type & 0x3F, 0x00, 0x01, 0x00, nalu.byteLength]), nalu]);
  };
  return Buffer.concat([fixed, Buffer.from([4]), array(32, VPS), array(33, SPS), array(34, PPS), Buffer.from([0x80 | 39, 0x00, 0x01, 0x00, 0x03]), Buffer.from(SEI, 'hex')]);
};

describe('hvc1 parameter sets', () => {
  test('VPS/SPS/PPS in the samples are removed, other NAL units are kept', () => {
    expect(strip_parameter_sets(sized(4, AUD, VPS, SPS, PPS, SEI, IDR), 4)).toStrictEqual(sized(4, AUD, SEI, IDR));
    expect(strip_parameter_sets(sized(4, TRAIL), 4)).toStrictEqual(sized(4, TRAIL));
    // VPS/SPS/PPS だけのメッセージは何も残らない (長さ 0 の NAL Unit も飛ばす)
    expect(strip_parameter_sets(sized(4, VPS, SPS, PPS, ''), 4).byteLength).toStrictEqual(0);
  });

  test('NAL unit length size comes from lengthSizeMinusOne', () => {
    expect(read_nal_unit_length_size(record(3))).toBe(4);
    expect(read_nal_unit_length_size(record(1))).toBe(2);
    expect(strip_parameter_sets(sized(2, VPS, SPS, PPS, IDR), read_nal_unit_length_size(record(1)))).toStrictEqual(sized(2, IDR));
  });

  test('array_completeness is 1 for VPS/SPS/PPS and 0 for SEI', () => {
    const track = write_mp4_hevc_track_information(1, 1000, record(3));
    const hvcC = track.subarray(track.indexOf('hvcC') + 4);
    const types: [number, number][] = [];
    let offset = 23;
    for (let i = 0; i < hvcC[22]; i++) {
      types.push([hvcC[offset] >> 7, hvcC[offset] & 0x3F]);
      const numNalus = hvcC.readUInt16BE(offset + 1);
      offset += 3;
      for (let j = 0; j < numNalus; j++) { offset += 2 + hvcC.readUInt16BE(offset); }
    }
    expect(types).toStrictEqual([[1, 32], [1, 33], [1, 34], [0, 39]]);
    expect(track.includes(Buffer.from([0x02, 0x80, 0x00, 0x00, 0x01, 0x68]))).toBe(true); // tkhd の width 640, height 360 (16.16 固定小数点)
  });

  test('HLSGenerator removes VPS/SPS/PPS from the samples of the segments', () => {
    // Enhanced RTMP の ExVideoTagHeader: IsExHeader (1bit), FrameType (3bit), PacketType (4bit), FourCC (32bit), (CodedFrames なら) CompositionTime (24bit)
    const hevc = (timestamp: number, frameType: number, packetType: number, body: Buffer): Message => {
      const header = Buffer.concat([Buffer.from([0x80 | (frameType << 4) | packetType]), Buffer.from('hvc1', 'ascii'), packetType === 1 ? Buffer.alloc(3) : Buffer.alloc(0)]);
      return { message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data: Buffer.concat([header, body]) };
    };
    const generator = new HLSGenerator();
    generator.feed({ message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', { videocodecid: 0x68766331 }] });
    generator.feed(hevc(0, 1, 0, record(3)));
    // x265 の repeat-headers のように、キーフレームごとに VPS/SPS/PPS も送ってくる
    for (let t = 0; t < 4000; t += 100) {
      generator.feed(t % 1000 === 0 ? hevc(t, 1, 1, sized(4, VPS, SPS, PPS, IDR)) : hevc(t, 2, 1, sized(4, TRAIL)));
    }
    generator.end();

    const segments = [... generator.m3u8().matchAll(/^(\d+)\.m4s$/gm)].map(([, msn]) => generator.segment(Number(msn))!);
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.includes(Buffer.from(IDR, 'hex'))).toBe(true);
      expect(segment.includes(Buffer.from(VPS, 'hex'))).toBe(false);
      expect(segment.includes(Buffer.from(SPS, 'hex'))).toBe(false);
      expect(segment.includes(Buffer.from(PPS, 'hex'))).toBe(false);
    }
  });
});
