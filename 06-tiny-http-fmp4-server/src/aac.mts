import { read_audio_specific_config } from '../../03-tiny-http-ts-server/src/aac.mts';
import { make, esds, mp4a, track } from './fmp4.mts';

const AAC_CHANNEL_COUNT = [0, 1, 2, 3, 4, 5, 6, 8, 0, 0, 0, 7, 8, 24, 8, 0];
export const aac_channel_count = (channelConfiguration: number): number => {
  return AAC_CHANNEL_COUNT[channelConfiguration] || 2;
};

export const write_mp4_aac_track_information = (track_id: number, timescale: number, audioSpecificConfig: Buffer): Buffer => {
  const { channelConfiguration, samplingFrequency } = read_audio_specific_config(audioSpecificConfig);

  return make((vector) => {
    track(track_id, 0, 0, timescale, 'soun', vector, (vector) => {
      mp4a(aac_channel_count(channelConfiguration), 16, samplingFrequency, vector, (vector) => {
        esds(audioSpecificConfig, vector, (vector) => {
          vector.write(Buffer.from([0x06, 0x01, 0x02])); // Sync Layer Descriptor
        });
      });
    });
  });
};
