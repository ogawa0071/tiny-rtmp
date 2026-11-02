import { describe, expect, test } from 'vitest';

import { write_annexb_avc, type AVCDecoderConfigurationRecord } from '../src/avc.mts';

const record = {
  configurationVersion: 1,
  AVCProfileIndication: 0x64,
  profile_compatibility: 0,
  AVCLevelIndication: 0x0d,
  lengthSize: 4,
  SequenceParameterSets: [Buffer.from('67aa', 'hex')],
  PictureParameterSets: [Buffer.from('68bb', 'hex')],
} satisfies AVCDecoderConfigurationRecord;

// NAL Unit を AVCC 形式 (4 byte の長さ + NAL Unit) で並べる
const avcc = (... nalus: string[]): Buffer => {
  return Buffer.concat(nalus.map((hex) => {
    const nalu = Buffer.from(hex, 'hex');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(nalu.byteLength);
    return Buffer.concat([length, nalu]);
  }));
};

// NAL Unit を Annex B 形式 (Start Code + NAL Unit) で並べる
const annexb = (... nalus: string[]): Buffer => {
  return Buffer.from(nalus.map((hex) => `00000001${hex}`).join(''), 'hex');
};

describe('AVCC to Annex B', () => {
  test('AUD, SPS and PPS are inserted before IDR', () => {
    expect(write_annexb_avc(avcc('65cc'), record)).toStrictEqual(annexb('09f0', '67aa', '68bb', '65cc'));
  });

  test('In-band SPS and PPS are not duplicated', () => {
    expect(write_annexb_avc(avcc('09f0', '67dd', '68ee', '65cc'), record)).toStrictEqual(annexb('09f0', '67dd', '68ee', '65cc'));
  });

  test('SPS is inserted before an in-band PPS without SPS', () => {
    expect(write_annexb_avc(avcc('68ee', '65cc'), record)).toStrictEqual(annexb('09f0', '67aa', '68ee', '65cc'));
  });

  test('Zero-length NAL units are skipped', () => {
    expect(write_annexb_avc(avcc('', '41cc'), record)).toStrictEqual(annexb('09f0', '41cc'));
  });
});
