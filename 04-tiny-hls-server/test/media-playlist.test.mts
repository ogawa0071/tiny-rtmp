import { describe, expect, test } from 'vitest';

import { PlaylistTimestamp } from '../src/playlist-timestamp.mts';
import MediaPlaylist from '../src/media-playlist.mts';

// interval ミリ秒ごとにキーフレームが来る映像を、count 個のセグメント分だけプレイリストに入れる
const publish = (playlist: MediaPlaylist, interval: number, count: number): void => {
  for (let i = 0; i <= count; i++) {
    const timestamp = PlaylistTimestamp.fromRTMP(i * interval);
    playlist.append(timestamp);
    playlist.feed([Buffer.from([i % 256])], timestamp);
  }
};

const durations = (m3u8: string): number[] => {
  return m3u8.split('\n').flatMap((line) => {
    const extinf = /^#EXTINF:([\d.]+),$/.exec(line);
    return extinf == null ? [] : [Number(extinf[1])];
  });
};

// プレイリストに載っているセグメントの番号
const numbers = (m3u8: string): number[] => {
  return [... m3u8.matchAll(/^(\d+)\.ts$/gm)].map(([, msn]) => Number(msn));
};

describe('Live window', () => {
  test('the playlist stays at least three target durations long', () => {
    const playlist = new MediaPlaylist({ liveWindowLength: 3 });
    publish(playlist, 1500, 10);

    const m3u8 = playlist.m3u8();
    const targetduration = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(m3u8)![1]);
    expect(targetduration).toStrictEqual(2); // 1.5 秒を切り上げる
    // セグメント 3 つ (4.5 秒) では 3 × 2 秒に足りないので、4 つ残す
    expect(durations(m3u8)).toStrictEqual([1.5, 1.5, 1.5, 1.5]);
  });
});

describe('End of stream', () => {
  test('the last segment is completed and EXT-X-ENDLIST is added', () => {
    const playlist = new MediaPlaylist({ liveWindowLength: 3 });
    publish(playlist, 1000, 5);
    // 最後のセグメントの途中までデータが届いてから、配信が終わる
    playlist.feed([Buffer.from([0])], PlaylistTimestamp.fromRTMP(5500));
    playlist.end();

    const m3u8 = playlist.m3u8();
    expect(m3u8.trimEnd().endsWith('#EXT-X-ENDLIST')).toStrictEqual(true);
    expect(durations(m3u8).at(-1)).toStrictEqual(0.5);
  });
});

describe('Media sequence number', () => {
  test('a publish right after one that was sent faster than real time does not reuse its numbers', () => {
    // 1 秒のセグメント 100 個を一度に送る (番号が 0.1 秒ごとに進む時計を追い越す)
    const previous = new MediaPlaylist({ liveWindowLength: 3 });
    publish(previous, 1000, 100);
    previous.end();
    const last = Math.max(... numbers(previous.m3u8()));

    const next = new MediaPlaylist({ liveWindowLength: 3 });
    publish(next, 1000, 3);
    expect(numbers(next.m3u8()).length).toStrictEqual(3);
    expect(Math.min(... numbers(next.m3u8()))).toBeGreaterThan(last);
  });
});
