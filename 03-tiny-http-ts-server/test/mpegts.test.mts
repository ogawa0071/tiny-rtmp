import { describe, expect, test } from 'vitest';

import { write_pes } from '../src/mpegts.mts';

describe('PES', () => {
  test('PTS and DTS', () => {
    const pes = write_pes(Buffer.alloc(0), 0xE0, 6000, 3000, true);
    // PTS_DTS_flags: '11', PES_header_data_length: 10
    expect(pes.subarray(7, 9)).toStrictEqual(Buffer.from('c00a', 'hex'));
  });

  test('DTS is omitted when it equals PTS', () => {
    const pes = write_pes(Buffer.alloc(0), 0xE0, 3000, 3000, true);
    // PTS_DTS_flags: '10', PES_header_data_length: 5, PTS の prefix は '0010'
    expect(pes.subarray(7, 10)).toStrictEqual(Buffer.from('800521', 'hex'));
    expect(pes.byteLength).toStrictEqual(9 + 5);
  });
});
