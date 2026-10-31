import { describe, expect, test } from 'vitest';

import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';
import MediaPlaylist from '../src/media-playlist.mts';

// fps の映像 (keyint フレームごとにキーフレーム) を frames フレーム分だけプレイリストに入れる (dropped が true になるフレームは欠けている)
const publish = (playlist: MediaPlaylist, fps: number, keyint: number, frames: number, dropped: (i: number) => boolean = () => false): void => {
  for (let i = 0; i < frames; i++) {
    if (dropped(i)) { continue; }
    const timestamp = PlaylistTimestamp.fromRTMP(Math.round(i * 1000 / fps)); // RTMP の timestamp はミリ秒
    const keyframe = i % keyint === 0;
    if (keyframe) { playlist.append(timestamp); }
    playlist.feed([Buffer.from([i % 256])], timestamp, true, keyframe);
  }
};

// プレイリストに載っている完成したセグメントごとの、パーシャルセグメントの長さと EXTINF
const segments = (m3u8: string): { parts: number[]; extinf: number; }[] => {
  const result: { parts: number[]; extinf: number; }[] = [];
  let parts: number[] = [];
  for (const line of m3u8.split('\n')) {
    const part = /^#EXT-X-PART:DURATION=([\d.]+)/.exec(line);
    if (part != null) { parts.push(Number(part[1])); }
    const extinf = /^#EXTINF:([\d.]+),/.exec(line);
    if (extinf != null) {
      result.push({ parts, extinf: Number(extinf[1]) });
      parts = [];
    }
  }
  return result;
};

// 作成中のセグメントの番号と、先読みのヒントになっているパーシャルセグメントの番号
const preload = (m3u8: string): [msn: number, part: number] => {
  const [, msn, part] = /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="(\d+)_(\d+)\.ts"/.exec(m3u8)!;
  return [Number(msn), Number(part)];
};

// プレイリストの PART-TARGET (秒)
const partTarget = (m3u8: string): number => {
  return Number(/#EXT-X-PART-INF:PART-TARGET=([\d.]+)/.exec(m3u8)![1]);
};

describe('Partial Segment', () => {
  // NTSC のフレームレート (29.97, 59.94, 23.976 fps) では、ミリ秒に丸めた timestamp の間隔が 1 ミリ秒ずつ揺れる
  test.each([
    ['30 fps, 1 s GOP, PART-TARGET 1', 30, 30, 1],
    ['29.97 fps, 1 s GOP, PART-TARGET 1', 30000 / 1001, 30, 1],
    ['25 fps, 2 s GOP, PART-TARGET 1', 25, 50, 1],
    ['29.97 fps, 2 s GOP, PART-TARGET 0.5', 30000 / 1001, 60, 0.5],
    ['29.97 fps, 2 s GOP, PART-TARGET 0.3', 30000 / 1001, 60, 0.3],
    ['59.94 fps, 2 s GOP, PART-TARGET 1', 60000 / 1001, 120, 1],
    ['23.976 fps, 2 s GOP, PART-TARGET 1', 24000 / 1001, 48, 1],
  ])('%s: every part is at most PART-TARGET and the parts add up to the segment', (_, fps, keyint, target) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: target });
    publish(playlist, fps, keyint, keyint * 6);

    const m3u8 = playlist.m3u8();
    // どれもフレームの境目で 85% 以上に区切れるので、指定の PART-TARGET のまま
    expect(partTarget(m3u8)).toStrictEqual(target);
    const list = segments(m3u8);
    expect(list.length).toBeGreaterThan(0);
    for (const { parts, extinf } of list) {
      for (const duration of parts) {
        expect(duration).toBeGreaterThan(0);
        expect(duration).toBeLessThanOrEqual(target);
      }
      expect(parts.reduce((total, duration) => total + duration, 0)).toBeCloseTo(extinf, 6);
    }
  });

  test('a frame after a dropped frame does not make the part longer than PART-TARGET', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 1 });
    // 30 fps の映像 (60 フレームごとにキーフレーム) で、各 GOP の 1 秒の位置のフレームが欠けている (エンコードが間に合わなかった時など)
    publish(playlist, 30, 60, 60 * 6, (i) => i % 60 === 30);

    const list = segments(playlist.m3u8());
    expect(list.length).toBeGreaterThan(0);
    for (const { parts } of list) {
      for (const duration of parts) {
        expect(duration).toBeLessThanOrEqual(1);
      }
    }
  });

  test('a part that has reached PART-TARGET is completed without waiting for the next frame', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.5 });
    // 作成中のセグメントの最後に届いたフレームは、0.5 秒の位置のフレーム
    publish(playlist, 30, 60, 60 * 4 + 16);

    // このフレームはどれだけ長くても 0 番のパーシャルセグメントには入らないので、0 番はもう完成している
    const [, part] = preload(playlist.m3u8());
    expect(part).toStrictEqual(1);
  });

  test.each([
    ['23.976 fps', 24000 / 1001, 48],
    ['15 fps', 15, 30],
    ['10 fps', 10, 20],
  ])('%s with a 0.25 s PART-TARGET: PART-TARGET is adjusted so that parts are at least 85% of it', (_, fps, keyint) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    publish(playlist, fps, keyint, keyint * 8);

    const m3u8 = playlist.m3u8();
    const target = partTarget(m3u8);
    const list = segments(m3u8);
    expect(list.length).toBeGreaterThan(0);
    for (const { parts } of list) {
      for (const duration of parts) {
        expect(duration).toBeLessThanOrEqual(target);
      }
      // 最初のパーシャルセグメント (キーフレームから始まるので INDEPENDENT=YES) とセグメントの最後のパーシャルセグメントは除く (RFC 8216bis 4.4.4.9)
      for (const duration of parts.slice(1, -1)) {
        expect(duration).toBeGreaterThanOrEqual(0.85 * target);
      }
    }
  });

  test('30 fps with a 1 s GOP and a 1 s PART-TARGET gives one part per segment', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 1 });
    publish(playlist, 30, 30, 30 * 8);

    for (const { parts } of segments(playlist.m3u8())) {
      expect(parts).toStrictEqual([1]);
    }
  });

  test('an audio frame that arrives before the keyframe with the same timestamp does not make an empty part', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 1 });
    // 20 ms ごとの音声と 30 fps の映像 (30 フレームごとにキーフレーム) を timestamp 順に入れる
    // timestamp が同じなら音声が先 (FFmpeg は同じ timestamp のパケットを stream の番号順に送るので、音声が stream 0 だとこうなる)
    const frames = [
      ... Array.from({ length: 50 * 8 }, (_, i) => ({ timestamp: i * 20, video: false, keyframe: false })),
      ... Array.from({ length: 30 * 8 }, (_, i) => ({ timestamp: Math.round(i * 1000 / 30), video: true, keyframe: i % 30 === 0 })),
    ].sort((a, b) => a.timestamp - b.timestamp || Number(a.video) - Number(b.video));
    for (const { timestamp, video, keyframe } of frames) {
      if (keyframe) { playlist.append(PlaylistTimestamp.fromRTMP(timestamp)); }
      playlist.feed([Buffer.alloc(1)], PlaylistTimestamp.fromRTMP(timestamp), video, keyframe);
    }

    const list = segments(playlist.m3u8());
    expect(list.length).toBeGreaterThan(0);
    for (const { parts } of list) {
      for (const duration of parts) {
        expect(duration).toBeGreaterThan(0);
      }
    }
  });
});

describe('Blocking Playlist Reload', () => {
  test('a segment that is no longer kept is already in the past', async () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 1 });
    publish(playlist, 30, 30, 30 * 8);

    // 番号は現在時刻から始まるので、0 はとても古いセグメント (再帰で探しに行かずにすぐ返す)
    expect(await playlist.block(0, 0)).toStrictEqual(true);
  });

  test('a part index past the end of a segment means part 0 of the next segment', async () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.5 });
    // 作成中のセグメントは 20 フレーム (約 0.67 秒) で、0 番のパーシャルセグメント (0.5 秒) は完成している
    publish(playlist, 30, 30, 30 * 8 + 20);

    const [msn, part] = preload(playlist.m3u8());
    expect(part).toStrictEqual(1);
    // 1 つ前のセグメントのパーシャルセグメントは 2 つ (0, 1 番) だけなので、5 番は作成中のセグメントの 0 番になる
    expect(await playlist.block(msn - 1, 5)).toStrictEqual(true);
  });

  test('requests too far ahead are rejected', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 1 });
    publish(playlist, 30, 30, 30 * 8 + 10);

    const [msn, part] = preload(playlist.m3u8());
    expect(playlist.tooFar(msn, part)).toStrictEqual(false);
    expect(playlist.tooFar(msn + 1, null)).toStrictEqual(false);
    expect(playlist.tooFar(msn + 2, null)).toStrictEqual(true);
    expect(playlist.tooFar(msn, part + 10)).toStrictEqual(true);
    expect(playlist.tooFar(msn + 1, 10)).toStrictEqual(true);
  });
});

describe('End of stream', () => {
  test('the last segment is completed, EXT-X-ENDLIST is added and directives are ignored', async () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 1 });
    publish(playlist, 30, 30, 30 * 8 + 10);
    const [msn] = preload(playlist.m3u8());

    playlist.end();
    const m3u8 = playlist.m3u8();
    expect(m3u8).toContain('#EXT-X-ENDLIST');
    expect(m3u8).not.toContain('#EXT-X-PRELOAD-HINT');
    expect(m3u8).toContain(`${msn}.ts`);
    // 10 フレーム分 (最後のフレームの長さも含む) の長さで完成している
    expect(segments(m3u8).at(-1)!.extinf).toBeCloseTo(10 / 30, 2);
    expect(playlist.tooFar(msn + 100, null)).toStrictEqual(false);
    expect(await playlist.block(msn + 100, null)).toStrictEqual(true);
  });
});
