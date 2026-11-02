import BitBuilder from './bit-builder.mts';

const PACKET_SIZE = 188;
const HEADER_SIZE = 4;
const PAYLOAD_SIZE = PACKET_SIZE - HEADER_SIZE;
const SYNC_BYTE = 0x47;
const STUFFING_BYTE = 0xFF;

const pes_not_contain_flags = new Set([0xBC, 0xBE, 0xBF, 0xF0, 0xF1, 0xFF, 0xF2, 0xF8]);
const pes_has_flags = (stream_id: number) => {
  return !pes_not_contain_flags.has(stream_id);
};

const crc32_table = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i << 24;
  for (let j = 0; j < 8; j++) {
    c = ((c << 1) ^ ((c & 0x80000000) ? 0x04c11db7 : 0)) >>> 0;
  }
  return c;
});
const crc32 = (data: Buffer) => {
  let crc = 0xFFFFFFFF;
  for (const datum of data) {
    crc = ((crc << 8) ^ crc32_table[((crc >>> 24) ^ datum) & 0xFF]) >>> 0;
  }
  return crc;
};

const finalize_section = (builder: BitBuilder): Buffer => {
  builder.writeBits(0, 32); // CRC32
  const section = builder.build();
  section.writeUInt16BE(section.readUInt16BE(1) | ((section.byteLength - 3) & 0x0FFF), 1);
  section.writeUInt32BE(crc32(section.subarray(0, -4)), section.byteLength - 4);
  return section;
};

export type PAT = {
  transport_stream_id: number;
  programs: {
    program_number: number;
    program_map_PID: number;
  }[];
};

export const write_pat = (pat: PAT) => {
  const builder = new BitBuilder();

  builder.writeBits(0x00, 8); // table_id
  builder.writeBits(1, 1); // section_syntax_indicator
  builder.writeBits(0, 1); // 0
  builder.writeBits(0b11, 2); // reserved
  builder.writeBits(0, 12); // section_length
  builder.writeBits(pat.transport_stream_id, 16); // transport_stream_id
  builder.writeBits(0b11, 2); // reserved
  builder.writeBits(0, 5); // version_number
  builder.writeBits(0b1, 1); // current_next_indicator
  builder.writeBits(0, 8); // section_number
  builder.writeBits(0, 8); // last_section_number
  for (const { program_number, program_map_PID } of pat.programs) {
    builder.writeBits(program_number, 16); // program_number
    builder.writeBits(0b111, 3); // reserved
    builder.writeBits(program_map_PID, 13); // program_map_PID
  }

  return finalize_section(builder);
};

export const StreamType = {
  PRIVATE_DATA: 0x06,
  AAC_ADTS: 0x0f,
  AAC_LATM: 0x11,
  AVC: 0x1b,
  METADATA: 0x15,
  HEVC: 0x24,
} as const;

export type PMT = {
  program_number: number;
  version_number: number;
  pcr_pid: number;
  program_info?: Buffer;
  streams: {
    stream_type: number;
    elementary_PID: number;
    ES_info?: Buffer;
  }[];
};

export const write_pmt = (pmt: PMT) => {
  const builder = new BitBuilder();

  builder.writeBits(0x02, 8); // table_id
  builder.writeBits(1, 1); // section_syntax_indicator
  builder.writeBits(0, 1); // 0
  builder.writeBits(0b11, 2); // reserved
  builder.writeBits(0, 12); // section_length
  builder.writeBits(pmt.program_number, 16); // program_number
  builder.writeBits(0b11, 2); // reserved
  builder.writeBits(pmt.version_number, 5); // version_number
  builder.writeBits(0b1, 1); // current_next_indicator
  builder.writeBits(0, 8); // section_number
  builder.writeBits(0, 8); // last_section_number
  builder.writeBits(0b111, 3); // reserved
  builder.writeBits(pmt.pcr_pid, 13); // PCR_PID
  builder.writeBits(0b1111, 4); // reserved
  builder.writeBits(pmt.program_info?.byteLength ?? 0, 12); // program_info_length
  builder.writeBytes(pmt.program_info ?? []); // program_info
  for (const { stream_type, elementary_PID, ES_info } of pmt.streams) {
    builder.writeBits(stream_type, 8); // stream_type
    builder.writeBits(0b111, 3); // reserved
    builder.writeBits(elementary_PID, 13); // elementary_PID
    builder.writeBits(0b1111, 4); // reserved
    builder.writeBits(ES_info?.byteLength ?? 0, 12); // ES_info_length
    builder.writeBytes(ES_info ?? []); // ES_info
  }

  return finalize_section(builder);
};

const write_timestamp = (builder: BitBuilder, prefix: number, timestamp: number): void => {
  builder.writeBits(prefix, 4);
  builder.writeBits(Math.floor(timestamp / 2 ** 30), 3);
  builder.writeBits(0b1, 1); // marker
  builder.writeBits(Math.floor(timestamp / 2 ** 15), 15);
  builder.writeBits(0b1, 1); // marker
  builder.writeBits(timestamp, 15);
  builder.writeBits(0b1, 1); // marker
};

export const write_pes = (data: Buffer, stream_id: number, pts: number | null, dts: number | null, omit_length = false) => {
  if (pts == null || dts === pts) { dts = null; }

  const builder = new BitBuilder();
  const PES_header_data_length = (pts != null ? 5 : 0) + (dts != null ? 5 : 0);

  builder.writeBits(0x000001, 24); // start_code_prefix
  builder.writeBits(stream_id, 8); // stream_id
  builder.writeBits(0, 16); // pes_length
  if (pes_has_flags(stream_id)) {
    builder.writeBits(0b10, 2);
    builder.writeBits(0, 2);
    builder.writeBits(0, 1);
    builder.writeBits(0, 1);
    builder.writeBits(0, 1);
    builder.writeBits(0, 1);
    builder.writeBits(pts != null ? 0b1 : 0b0, 1); // pts present
    builder.writeBits(dts != null ? 0b1 : 0b0, 1); // dts present
    builder.writeBits(0, 6);
    builder.writeBits(PES_header_data_length, 8); // PES_header_data_length
    if (pts != null) {
      write_timestamp(builder, dts != null ? 0b0011 : 0b0010, pts);
    }
    if (dts != null) {
      write_timestamp(builder, 0b0001, dts);
    }
  }
  const header = builder.build();
  const pes = Buffer.concat([header, data]);
  if (!omit_length) { pes.writeUInt16BE(pes.byteLength - 6, 4); }
  return pes;
};

type TransportPacketHeader = {
  pid: number;
  payload_unit_start_indicator: boolean;
  adaptation_field: boolean;
  payload: boolean;
  continuity_counter: number;
};

const write_header = (builder: BitBuilder, header: TransportPacketHeader): void => {
  builder.writeBits(SYNC_BYTE, 8);
  builder.writeBits(0, 1); // transport_err_indicator
  builder.writeBool(header.payload_unit_start_indicator); // payload_unit_start_indicator
  builder.writeBits(0, 1); // transport_priority
  builder.writeBits(header.pid, 13);
  builder.writeBits(0, 2); // transport_scrambling_control
  builder.writeBool(header.adaptation_field); // adaptation_field_control (adaptation_field present)
  builder.writeBool(header.payload); // adaptation_field_control (payload present)
  builder.writeBits(header.continuity_counter, 4); // continiuty_counter
};

export class SectionPacketizer {
  private continuity_counter: number = 0;
  private pid: number;

  public constructor(pid: number) {
    this.pid = pid;
  }

  public *packetize(section: Buffer): Generator<Buffer> {
    const payload = Buffer.concat([Buffer.from([0x00]), section]);

    for (let offset = 0; offset < payload.byteLength; offset += PAYLOAD_SIZE) {
      const builder = new BitBuilder();
      write_header(builder, {
        pid: this.pid,
        payload_unit_start_indicator: offset === 0,
        adaptation_field: false,
        payload: true,
        continuity_counter: this.continuity_counter,
      });

      const packet = Buffer.alloc(PACKET_SIZE, STUFFING_BYTE);
      builder.build().copy(packet, 0);
      payload.copy(packet, HEADER_SIZE, offset, offset + PAYLOAD_SIZE);

      yield packet;
      this.continuity_counter = (this.continuity_counter + 1) & 0x0F;
    }
  }
}

export class PESPacketizer {
  private continuity_counter: number = 0;
  private pid: number;

  public constructor(pid: number) {
    this.pid = pid;
  }

  public *packetize(pes: Buffer): Generator<Buffer> {
    for (let offset = 0; offset < pes.byteLength; offset += PAYLOAD_SIZE) {
      const payload = pes.subarray(offset, offset + PAYLOAD_SIZE);
      const stuffing = PAYLOAD_SIZE - payload.byteLength;

      const builder = new BitBuilder();
      write_header(builder, {
        pid: this.pid,
        payload_unit_start_indicator: offset === 0,
        adaptation_field: stuffing > 0,
        payload: true,
        continuity_counter: this.continuity_counter,
      });
      if (stuffing > 0) { builder.writeBits(stuffing - 1, 8); }
      if (stuffing > 1) { builder.writeBits(0, 8); }

      const packet = Buffer.alloc(PACKET_SIZE, STUFFING_BYTE);
      builder.build().copy(packet, 0);
      payload.copy(packet, PACKET_SIZE - payload.byteLength);

      yield packet;
      this.continuity_counter = (this.continuity_counter + 1) & 0x0F;
    }
  }
}

export class PCRPacketizer {
  private pid: number;

  public constructor(pid: number) {
    this.pid = pid;
  }

  public packetize(pcr: number): Buffer {
    const builder = new BitBuilder();
    write_header(builder, {
      pid: this.pid,
      payload_unit_start_indicator: false,
      adaptation_field: true,
      payload: false,
      continuity_counter: 0,
    });
    builder.writeBits(PACKET_SIZE - HEADER_SIZE - 1, 8); // adaptation field length
    builder.writeBits(0x10, 8); // PCR is Present
    builder.writeBits(pcr, 33); // PCR base
    builder.writeBits(0b111111, 6); // reserved
    builder.writeBits(0, 9); // PCR extension

    const packet = Buffer.alloc(PACKET_SIZE, STUFFING_BYTE);
    builder.build().copy(packet);
    return packet;
  }
}
