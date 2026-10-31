import { describe, expect, test } from 'vitest';

import { read_audio_specific_config, write_adts_aac } from '../src/aac.mts';

describe('AudioSpecificConfig', () => {
  test('AAC-LC', () => {
    // AOT: 2 (AAC-LC), samplingFrequencyIndex: 4 (44100Hz), channelConfiguration: 2
    expect(read_audio_specific_config(Buffer.from('1210', 'hex'))).toStrictEqual({
      audioObjectType: 2,
      samplingFrequencyIndex: 4,
      samplingFrequency: 44100,
      channelConfiguration: 2,
      coreAudioObjectType: 2,
    });
  });

  test('HE-AAC (explicit signaling)', () => {
    // AOT: 5 (SBR), samplingFrequencyIndex: 7 (22050Hz), channelConfiguration: 1, extensionSamplingFrequencyIndex: 4 (44100Hz), AOT: 2 (AAC-LC)
    expect(read_audio_specific_config(Buffer.from('2b8a0800', 'hex'))).toStrictEqual({
      audioObjectType: 5,
      samplingFrequencyIndex: 7,
      samplingFrequency: 22050,
      channelConfiguration: 1,
      coreAudioObjectType: 2,
    });
  });
});

describe('ADTS', () => {
  test('AAC-LC', () => {
    const adts = write_adts_aac(Buffer.alloc(10), read_audio_specific_config(Buffer.from('1210', 'hex')));
    // syncword, ID: 0 (MPEG-4), layer: 0, protection_absent: 1, profile: 1 (AAC-LC), sampling_frequency_index: 4, channel_configuration: 2, frame_length: 17
    expect(adts.subarray(0, 7)).toStrictEqual(Buffer.from('fff15080023ffc', 'hex'));
    expect(adts.byteLength).toStrictEqual(17);
  });

  test('HE-AAC is written as its core AAC', () => {
    const adts = write_adts_aac(Buffer.alloc(10), read_audio_specific_config(Buffer.from('2b8a0800', 'hex')));
    // profile: 1 (AAC-LC), sampling_frequency_index: 7 (SBR で拡張する前の 22050Hz), channel_configuration: 1
    expect((adts[2] >> 6) & 0b11).toStrictEqual(1);
    expect((adts[2] >> 2) & 0b1111).toStrictEqual(7);
  });
});
