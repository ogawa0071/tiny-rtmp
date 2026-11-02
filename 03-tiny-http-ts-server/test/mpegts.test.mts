import { describe, expect, test } from 'vitest';

import { write_pes } from '../src/mpegts.mts';

describe('PES', () => {
  test('PTS and DTS', () => {
    const pes = write_pes(Buffer.alloc(0), 0xE0, 6000, 3000, true);
    expect(pes.subarray(7, 9)).toStrictEqual(Buffer.from('c00a', 'hex'));
  });

  test('DTS is omitted when it equals PTS', () => {
    const pes = write_pes(Buffer.alloc(0), 0xE0, 3000, 3000, true);
    expect(pes.subarray(7, 10)).toStrictEqual(Buffer.from('800521', 'hex'));
    expect(pes.byteLength).toStrictEqual(9 + 5);
  });
});
