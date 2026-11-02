import type { AudioSpecificConfig } from '../../03-tiny-http-ts-server/src/aac.mts';
import type { AVCDecoderConfigurationRecord } from '../../03-tiny-http-ts-server/src/avc.mts';

export const avcMimeTypeCodec = ({ AVCProfileIndication, profile_compatibility, AVCLevelIndication }: AVCDecoderConfigurationRecord): string => {
  const bytes = Uint8Array.of(AVCProfileIndication, profile_compatibility, AVCLevelIndication);
  return `avc1.${bytes.toHex().toUpperCase()}`;
};

export const aacMimeTypeCodec = ({ audioObjectType }: AudioSpecificConfig): string => {
  return `mp4a.40.${audioObjectType}`;
};
