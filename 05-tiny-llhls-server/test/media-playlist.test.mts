import { describe, expect, test } from 'vitest';

import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';
import MediaPlaylist from '../src/media-playlist.mts';

const publish = (playlist: MediaPlaylist, fps: number, keyint: number, frames: number, dropped: (i: number) => boolean = () => false): void => {
  for (let i = 0; i < frames; i++) {
    if (dropped(i)) { continue; }
    const timestamp = PlaylistTimestamp.fromRTMP(Math.round(i * 1000 / fps));
    const keyframe = i % keyint === 0;
    if (keyframe) { playlist.append(timestamp); }
    playlist.feed([Buffer.from([i % 256])], timestamp, true, keyframe);
  }
};

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

const preload = (m3u8: string): [msn: number, part: number] => {
  const [, msn, part] = /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="(\d+)_(\d+)\.ts"/.exec(m3u8)!;
  return [Number(msn), Number(part)];
};

const partTarget = (m3u8: string): number => {
  return Number(/#EXT-X-PART-INF:PART-TARGET=([\d.]+)/.exec(m3u8)![1]);
};

describe('Partial Segment', () => {
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
    publish(playlist, 30, 60, 60 * 4 + 16);

    const [, part] = preload(playlist.m3u8());
    expect(part).toStrictEqual(1);
  });

  test('a frame longer than PART-TARGET (the video stalled) becomes a part of its own, completed when the next frame arrives', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    publish(playlist, 30, 60, 60 * 3 + 12, (i) => i >= 60 * 3 + 2 && i < 60 * 3 + 11);

    const [, part] = preload(playlist.m3u8());
    expect(part).toStrictEqual(2);
  });

  test.each([
    ['25 fps, 2 s GOP, PART-TARGET 0.5', 25, 50, 0.5, 0.5],
    ['30 fps, 2 s GOP, PART-TARGET 0.25', 30, 60, 0.25, 0.25],
    ['24 fps, 2 s GOP, PART-TARGET 0.25 (6 frames, PART-TARGET 0.251)', 24, 48, 0.25, 0.251],
    ['23.976 fps, 2 s GOP, PART-TARGET 0.25 (6 frames, PART-TARGET 0.251)', 24000 / 1001, 48, 0.25, 0.251],
    ['15 fps, 2 s GOP, PART-TARGET 0.25 (3 frames, PART-TARGET 0.201)', 15, 30, 0.25, 0.201],
    ['3 fps, 2 s GOP, PART-TARGET 0.25 (1 frame, PART-TARGET 0.334)', 3, 6, 0.25, 0.334],
  ])('%s: each part is added within PART-TARGET after the previous one', (_, fps, keyint, target, decided) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: target });
    const added = new Map<string, number>();
    for (let i = 0; i < keyint * 8; i++) {
      const ms = Math.round(i * 1000 / fps);
      const timestamp = PlaylistTimestamp.fromRTMP(ms);
      const keyframe = i % keyint === 0;
      if (keyframe) { playlist.append(timestamp); }
      playlist.feed([Buffer.alloc(1)], timestamp, true, keyframe);
      for (const [, uri] of playlist.m3u8().matchAll(/#EXT-X-PART:DURATION=[\d.]+,URI="([^"]+)"/g)) {
        if (!added.has(uri)) { added.set(uri, ms); }
      }
    }

    const times = [... added.values()].filter((ms) => ms >= Math.round(keyint * 3 * 1000 / fps));
    expect(times.length).toBeGreaterThan(8);
    expect(partTarget(playlist.m3u8())).toStrictEqual(decided);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeLessThanOrEqual(decided * 1000);
    }
  });

  test.each([
    ['23.976 fps', 24000 / 1001, 48, 0.251],
    ['24 fps', 24, 48, 0.251],
    ['15 fps', 15, 30, 0.201],
    ['12 fps', 12, 24, 0.251],
    ['10 fps', 10, 20, 0.201],
  ])('%s with a 0.25 s PART-TARGET: PART-TARGET is adjusted so that parts are at least 85% of it', (_, fps, keyint, expected) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    publish(playlist, fps, keyint, keyint * 8);

    const m3u8 = playlist.m3u8();
    const target = partTarget(m3u8);
    expect(target).toStrictEqual(expected);
    const list = segments(m3u8);
    expect(list.length).toBeGreaterThan(0);
    for (const { parts } of list) {
      for (const duration of parts) {
        expect(duration).toBeLessThanOrEqual(target);
      }
      for (const duration of parts.slice(1, -1)) {
        expect(duration).toBeGreaterThanOrEqual(0.85 * target);
      }
    }
  });

  test.each([
    ['a dropped frame at the end of the first part', 0.25, (i: number) => i === 7],
    ['a 1 s stall after the first 2 frames', 1, (i: number) => i >= 2 && i < 32],
    ['a 1 s stall after the first frame', 0.25, (i: number) => i >= 1 && i < 31],
  ])('30 fps, %s: PART-TARGET stays as specified', (_, target, dropped) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: target });
    publish(playlist, 30, 60, 60 * 8, dropped);

    expect(partTarget(playlist.m3u8())).toStrictEqual(target);
  });

  test.each<[string, number, number, number, number, number, number[], number[]]>([
    ['15 fps, the 3rd frame 51 ms longer', 15, 30, 3, 51, 0.201, [], []],
    ['15 fps, the 3rd frame 59 ms longer', 15, 30, 3, 59, 0.201, [], []],
    ['15 fps, the 2nd frame 118 ms longer', 15, 30, 2, 118, 0.201, [], []],
    ['15 fps, the 3rd frame 110 ms longer', 15, 30, 3, 110, 0.201, [0.244], []],
    ['23.976 fps, the 5th frame 60 ms longer', 24000 / 1001, 48, 5, 60, 0.251, [], []],
    ['20 fps, the 2nd frame 151 ms longer', 20, 40, 2, 151, 0.251, [], [0.201]],
    ['9 fps, the 2nd frame 33 ms longer', 9, 18, 2, 33, 0.25, [], [0.144]],
    ['18 fps, the 4th frame 29 ms longer', 18, 36, 4, 29, 0.25, [], [0.195]],
    ['23.976 fps, the 2nd frame 211 ms longer', 24000 / 1001, 48, 2, 211, 0.21, [0.252], []],
  ])('%s: PART-TARGET is not decided from the part that starts with the long frame', (_, fps, keyint, from, delay, expected, exceeding, short) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    let published = '';
    for (let i = 0; i < keyint * 8; i++) {
      const timestamp = PlaylistTimestamp.fromRTMP(Math.round(i * 1000 / fps) + (i >= from ? delay : 0));
      const keyframe = i % keyint === 0;
      if (keyframe) { playlist.append(timestamp); }
      playlist.feed([Buffer.from([i % 256])], timestamp, true, keyframe);
      if (published === '' && segments(playlist.m3u8()).length === 3) { published = playlist.m3u8(); }
    }

    const m3u8 = playlist.m3u8();
    const target = partTarget(m3u8);
    expect(target).toStrictEqual(expected);
    const first = segments(published);
    expect(first.flatMap(({ parts }) => parts).filter((duration) => duration > target)).toStrictEqual(exceeding);
    expect(first.flatMap(({ parts }) => parts.slice(1, -1)).filter((duration) => duration < 0.85 * target)).toStrictEqual(short);
    const list = segments(m3u8);
    expect(list.length).toBeGreaterThan(0);
    for (const { parts } of list) {
      for (const duration of parts) {
        expect(duration).toBeLessThanOrEqual(target);
      }
      for (const duration of parts.slice(1, -1)) {
        expect(duration).toBeGreaterThanOrEqual(0.85 * target);
      }
    }
  });

  test.each([
    ['15 fps, the 3rd frame 68 ms longer', 15, 30, 3, 68, 0.203],
    ['15 fps, the 2nd frame 136 ms longer', 15, 30, 2, 136, 0.203],
  ])('%s: the part that starts with the long frame stays within PART-TARGET if the regular parts are still at least 85% of it', (_, fps, keyint, from, delay, expected) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    for (let i = 0; i <= keyint * 3; i++) {
      const timestamp = PlaylistTimestamp.fromRTMP(Math.round(i * 1000 / fps) + (i >= from ? delay : 0));
      const keyframe = i % keyint === 0;
      if (keyframe) { playlist.append(timestamp); }
      playlist.feed([Buffer.from([i % 256])], timestamp, true, keyframe);
    }

    const m3u8 = playlist.m3u8();
    const target = partTarget(m3u8);
    expect(target).toStrictEqual(expected);
    const list = segments(m3u8);
    expect(list.length).toStrictEqual(3);
    for (const { parts } of list) {
      for (const duration of parts) {
        expect(duration).toBeLessThanOrEqual(target);
      }
      for (const duration of parts.slice(1, -1)) {
        expect(duration).toBeGreaterThanOrEqual(0.85 * target);
      }
    }
  });

  test('12 fps with truncated timestamps, the 3rd frame 33 ms longer: PART-TARGET is not decided from the part that starts with the long frame', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    for (let i = 0; i < 24 * 8; i++) {
      const timestamp = PlaylistTimestamp.fromRTMP(Math.floor(i * 1000 / 12) + (i >= 3 ? 33 : 0));
      const keyframe = i % 24 === 0;
      if (keyframe) { playlist.append(timestamp); }
      playlist.feed([Buffer.from([i % 256])], timestamp, true, keyframe);
    }

    const m3u8 = playlist.m3u8();
    const target = partTarget(m3u8);
    expect(target).toStrictEqual(0.251);
    const list = segments(m3u8);
    expect(list.length).toBeGreaterThan(0);
    for (const { parts } of list) {
      for (const duration of parts) {
        expect(duration).toBeLessThanOrEqual(target);
      }
      for (const duration of parts.slice(1, -1)) {
        expect(duration).toBeGreaterThanOrEqual(0.85 * target);
      }
    }
  });

  test('12 fps with truncated timestamps, the 3rd frame 25 ms longer: PART-TARGET is decided from the part that starts with the long frame when the regular parts still reach 85% of it', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    for (let i = 0; i < 24 * 8; i++) {
      const timestamp = PlaylistTimestamp.fromRTMP(Math.floor(i * 1000 / 12) + (i >= 3 ? 25 : 0));
      const keyframe = i % 24 === 0;
      if (keyframe) { playlist.append(timestamp); }
      playlist.feed([Buffer.from([i % 256])], timestamp, true, keyframe);
    }

    const m3u8 = playlist.m3u8();
    const target = partTarget(m3u8);
    expect(target).toStrictEqual(0.193);
    for (const { parts } of segments(m3u8)) {
      for (const duration of parts) {
        expect(duration).toBeLessThanOrEqual(target);
      }
      for (const duration of parts.slice(1, -1)) {
        expect(duration).toBeGreaterThanOrEqual(0.85 * target);
      }
    }
  });

  test('PART-TARGET decided after a part cut short is not shorter than that part', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    const jittered = [0, 43, 85, 128, 171, 210, 252, 294, 335, 376, 418, 461];
    for (let i = 0; i <= 48 * 3; i++) {
      const timestamp = PlaylistTimestamp.fromRTMP(jittered[i] ?? Math.round(i * 1001 / 24));
      const keyframe = i % 48 === 0;
      if (keyframe) { playlist.append(timestamp); }
      playlist.feed([Buffer.from([i % 256])], timestamp, true, keyframe);
    }

    const m3u8 = playlist.m3u8();
    const target = partTarget(m3u8);
    expect(target).toStrictEqual(0.211);
    const list = segments(m3u8);
    expect(list.length).toStrictEqual(3);
    for (const { parts } of list) {
      for (const duration of parts) {
        expect(duration).toBeLessThanOrEqual(target);
      }
      for (const duration of parts.slice(1, -1)) {
        expect(duration).toBeGreaterThanOrEqual(0.85 * target);
      }
    }
  });

  test.each([
    ['3 fps, 2 s GOP, PART-TARGET 0.25', 3, 6, 0.25, 0.334],
    ['2 fps, 2 s GOP, PART-TARGET 0.25', 2, 4, 0.25, 0.501],
    ['1 fps, every frame a keyframe, PART-TARGET 0.5', 1, 1, 0.5, 1.001],
  ])('%s: a frame is longer than PART-TARGET, so PART-TARGET becomes one frame', (_, fps, keyint, target, expected) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: target });
    publish(playlist, fps, keyint, fps * 12);

    const m3u8 = playlist.m3u8();
    expect(partTarget(m3u8)).toStrictEqual(expected);
    const list = segments(m3u8);
    expect(list.length).toBeGreaterThan(0);
    for (const { parts } of list) {
      for (const duration of parts) {
        expect(duration).toBeLessThanOrEqual(expected);
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

    expect(await playlist.block(0, 0)).toStrictEqual(true);
  });

  test('a part index past the end of a segment means part 0 of the next segment', async () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.5 });
    publish(playlist, 30, 30, 30 * 8 + 20);

    const [msn, part] = preload(playlist.m3u8());
    expect(part).toStrictEqual(1);
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
    expect(segments(m3u8).at(-1)!.extinf).toBeCloseTo(10 / 30, 2);
    expect(playlist.tooFar(msn + 100, null)).toStrictEqual(false);
    expect(await playlist.block(msn + 100, null)).toStrictEqual(true);
  });
});
