import { describe, expect, test } from 'vitest';

import { read_audio_specific_config, write_adts_aac } from '../src/aac.mts';

describe('AudioSpecificConfig', () => {
  test('AAC-LC', () => {
    expect(read_audio_specific_config(Buffer.from('1210', 'hex'))).toStrictEqual({
      audioObjectType: 2,
      samplingFrequencyIndex: 4,
      samplingFrequency: 44100,
      channelConfiguration: 2,
      coreAudioObjectType: 2,
      programConfigElement: null,
    });
  });

  test('HE-AAC (explicit signaling)', () => {
    expect(read_audio_specific_config(Buffer.from('2b8a0800', 'hex'))).toStrictEqual({
      audioObjectType: 5,
      samplingFrequencyIndex: 7,
      samplingFrequency: 22050,
      channelConfiguration: 1,
      coreAudioObjectType: 2,
      programConfigElement: null,
    });
  });
});

describe('ADTS', () => {
  test('channelConfiguration 0 carries the program_config_element in every frame', () => {
    const asc = read_audio_specific_config(Buffer.from('120005040000200d4c61766336302e33312e31303256e500', 'hex'));
    const pce = Buffer.from('a0a0800004000d4c61766336302e33312e313032', 'hex');
    expect(asc.programConfigElement).toStrictEqual(pce);
    const adts = write_adts_aac(Buffer.from('de02', 'hex'), asc);
    expect(adts.subarray(7)).toStrictEqual(Buffer.concat([pce, Buffer.from('de02', 'hex')]));
    expect(((adts[3] & 0b11) << 11) | (adts[4] << 3) | (adts[5] >> 5)).toStrictEqual(7 + pce.byteLength + 2);
  });

  test('AAC-LC', () => {
    const adts = write_adts_aac(Buffer.alloc(10), read_audio_specific_config(Buffer.from('1210', 'hex')));
    expect(adts.subarray(0, 7)).toStrictEqual(Buffer.from('fff15080023ffc', 'hex'));
    expect(adts.byteLength).toStrictEqual(17);
  });

  test('HE-AAC is written as its core AAC', () => {
    const adts = write_adts_aac(Buffer.alloc(10), read_audio_specific_config(Buffer.from('2b8a0800', 'hex')));
    expect((adts[2] >> 6) & 0b11).toStrictEqual(1);
    expect((adts[2] >> 2) & 0b1111).toStrictEqual(7);
  });
});
