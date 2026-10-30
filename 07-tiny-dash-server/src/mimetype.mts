import type { AudioSpecificConfig } from '../../03-tiny-http-ts-server/src/aac.mts';
import type { AVCDecoderConfigurationRecord } from '../../03-tiny-http-ts-server/src/avc.mts';

const hex = (value: number): string => value.toString(16).toUpperCase().padStart(2, '0');

// avc1.PPCCLL (profile, profile_compatibility, level をそれぞれ 16 進数 2 桁で)
export const avcMimeTypeCodec = ({ AVCProfileIndication, profile_compatibility, AVCLevelIndication }: AVCDecoderConfigurationRecord): string => {
  return `avc1.${hex(AVCProfileIndication)}${hex(profile_compatibility)}${hex(AVCLevelIndication)}`;
};

// mp4a.40.AOT (40 は MPEG-4 Audio を表す ObjectTypeIndication)
export const aacMimeTypeCodec = ({ audioObjectType }: AudioSpecificConfig): string => {
  return `mp4a.40.${audioObjectType}`;
};
