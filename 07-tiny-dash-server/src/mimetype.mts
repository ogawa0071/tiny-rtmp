import type { AudioSpecificConfig } from '../../03-tiny-http-ts-server/src/aac.mts';
import type { AVCDecoderConfigurationRecord } from '../../03-tiny-http-ts-server/src/avc.mts';

// avc1.PPCCLL (profile, profile_compatibility, level の 3 バイトを 16 進数で)
export const avcMimeTypeCodec = ({ AVCProfileIndication, profile_compatibility, AVCLevelIndication }: AVCDecoderConfigurationRecord): string => {
  const bytes = Uint8Array.of(AVCProfileIndication, profile_compatibility, AVCLevelIndication);
  return `avc1.${bytes.toHex().toUpperCase()}`;
};

// mp4a.40.AOT (40 は MPEG-4 Audio を表す ObjectTypeIndication)
export const aacMimeTypeCodec = ({ audioObjectType }: AudioSpecificConfig): string => {
  return `mp4a.40.${audioObjectType}`;
};
