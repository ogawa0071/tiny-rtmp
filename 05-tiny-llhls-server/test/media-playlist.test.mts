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

  test('a frame longer than PART-TARGET (the video stalled) becomes a part of its own, completed when the next frame arrives', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    // 30 fps の映像 (60 フレームごとにキーフレーム) で、プレイリストを公開した後のセグメントの 2 フレーム目の後に、映像が約 0.33 秒途切れる
    publish(playlist, 30, 60, 60 * 3 + 12, (i) => i >= 60 * 3 + 2 && i < 60 * 3 + 11);

    // 途切れる前のフレームは PART-TARGET より長いので、1 フレームだけで 1 番のパーシャルセグメントになって、次のフレームが届いた時にはもう完成している
    const [, part] = preload(playlist.m3u8());
    expect(part).toStrictEqual(2);
  });

  // パーシャルセグメントは、1 つ前のものを追加してから PART-TARGET 以内に追加しなければならない (RFC 8216bis 6.2.1)
  // 映像のフレームは timestamp の時刻に届くものとして、それぞれのパーシャルセグメントがプレイリストに載った時刻を調べる
  // (セグメントの最後のパーシャルセグメントはキーフレームが届いた時に載るので、次のセグメントの 0 番が遅れやすい)
  test.each([
    ['25 fps, 2 s GOP, PART-TARGET 0.5', 25, 50, 0.5, 0.5],
    ['30 fps, 2 s GOP, PART-TARGET 0.25', 30, 60, 0.25, 0.25],
    ['24 fps, 2 s GOP, PART-TARGET 0.25 (6 frames, PART-TARGET 0.251)', 24, 48, 0.25, 0.251],
    ['23.976 fps, 2 s GOP, PART-TARGET 0.25 (6 frames, PART-TARGET 0.251)', 24000 / 1001, 48, 0.25, 0.251],
    ['15 fps, 2 s GOP, PART-TARGET 0.25 (3 frames, PART-TARGET 0.201)', 15, 30, 0.25, 0.201],
    ['3 fps, 2 s GOP, PART-TARGET 0.25 (1 frame, PART-TARGET 0.334)', 3, 6, 0.25, 0.334],
  ])('%s: each part is added within PART-TARGET after the previous one', (_, fps, keyint, target, decided) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: target });
    // パーシャルセグメントの URI と、それがプレイリストに載った時刻 (ミリ秒)
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

    // プレイリストを公開した後 (4 つ目のセグメントが始まってから) の間隔
    const times = [... added.values()].filter((ms) => ms >= Math.round(keyint * 3 * 1000 / fps));
    expect(times.length).toBeGreaterThan(8);
    expect(partTarget(playlist.m3u8())).toStrictEqual(decided);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeLessThanOrEqual(decided * 1000);
    }
  });

  // 15 fps と 10 fps は、0.25 秒に入るフレーム (3 フレーム、2 フレーム) では 80% にしかならない
  // 24 fps と 12 fps はちょうど 0.25 秒に入るが、23.976 fps (6 フレームが 0.251 秒になることがある) と最初のパーシャルセグメントだけでは見分けられない
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
      // 最初のパーシャルセグメント (キーフレームから始まるので INDEPENDENT=YES) とセグメントの最後のパーシャルセグメントは除く (RFC 8216bis 4.4.4.9)
      for (const duration of parts.slice(1, -1)) {
        expect(duration).toBeGreaterThanOrEqual(0.85 * target);
      }
    }
  });

  // フレームが欠けたり映像が途切れたりしても、それで短く区切ったパーシャルセグメントや、1 フレームだけの長いパーシャルセグメントからは PART-TARGET を決めない
  test.each([
    // 30 fps で 0.25 秒なら 7 フレーム (約 0.233 秒、93%) ごとに区切れるが、最初のパーシャルセグメントの 7 番目のフレームの次が欠けている
    ['a dropped frame at the end of the first part', 0.25, (i: number) => i === 7],
    // 最初の 2 フレームの後、映像が約 1 秒途切れる (配信を始めた直後のエンコーダなど)
    ['a 1 s stall after the first 2 frames', 1, (i: number) => i >= 2 && i < 32],
    // 最初のフレームの後、映像が約 1 秒途切れる (フレームの間隔が 1 つだけ長いので、フレームレートが低いとはみなさない)
    ['a 1 s stall after the first frame', 0.25, (i: number) => i >= 1 && i < 31],
  ])('30 fps, %s: PART-TARGET stays as specified', (_, target, dropped) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: target });
    publish(playlist, 30, 60, 60 * 8, dropped);

    // フレームが欠けていなければ 85% 以上に区切れるので、指定の PART-TARGET のまま
    expect(partTarget(playlist.m3u8())).toStrictEqual(target);
  });

  // 映像が少しだけ途切れると、短く区切ったパーシャルセグメントの次のパーシャルセグメントは、いつもより長いフレームから始まる
  // そこから PART-TARGET を決めたり、その長さに合わせて PART-TARGET を長くしたりすると、その後のいつも通りのパーシャルセグメントがどれも 85% に届かない
  // (expected は PART-TARGET、exceeding と short は、プレイリストを公開した時に載っていて、PART-TARGET を超えるものと 85% に届かないもの)
  test.each<[string, number, number, number, number, number, number[], number[]]>([
    // 0 番は 2 フレーム (0.133 秒) で短く区切り、1 番は長いフレームと次のフレーム (0.185 秒、2 フレーム) になる
    ['15 fps, the 3rd frame 51 ms longer', 15, 30, 3, 51, 0.201, [], []],
    ['15 fps, the 3rd frame 59 ms longer', 15, 30, 3, 59, 0.201, [], []],
    // 1 番は長いフレームだけ (0.184 秒、1 フレーム) になる
    ['15 fps, the 2nd frame 118 ms longer', 15, 30, 2, 118, 0.201, [], []],
    // 1 番 (0.244 秒、2 フレーム) に合わせた PART-TARGET (0.245 秒) では 3 フレーム (0.2 秒) が 85% に届かないので、合わせない (1 番は PART-TARGET を超える)
    ['15 fps, the 3rd frame 110 ms longer', 15, 30, 3, 110, 0.201, [0.244], []],
    // 1 番 (0.227 秒、4 フレーム) は 85% 以上なので、そこから決めると PART-TARGET が 0.25 秒のままになり、5 フレーム (0.209 秒) で区切ることがある
    ['23.976 fps, the 5th frame 60 ms longer', 24000 / 1001, 48, 5, 60, 0.251, [], []],
    // 1 番は長いフレームだけ (0.201 秒、1 フレーム) になる。その後のいつも通りの 5 フレーム (0.25 秒) から PART-TARGET を 0.251 秒にするので、1 番は 85% に届かない
    // (この配信なら、1 番から決めても (0.202 秒) 4 フレーム (0.2 秒) ごとに区切れて 85% 以上になるが、
    //  長いフレームから始まるものから決めると、その後のいつも通りのパーシャルセグメントが配信の最後まで 85% に届かないことがあるので、決めない)
    ['20 fps, the 2nd frame 151 ms longer', 20, 40, 2, 151, 0.251, [], [0.201]],
    // 0 番は 1 フレーム (0.111 秒) で短く区切り、1 番は長いフレームだけ (0.144 秒、1 フレーム) になる
    // 長いフレームは 1 つ前のフレームの 1.3 倍ほどだが、1 番から決めると (0.145 秒)、いつもの 1 フレーム (0.111 秒) が 85% に届かないので決めない。
    // その後のいつも通りの 2 フレーム (0.222 秒) で区切れるので PART-TARGET は 0.25 秒のままで、1 番だけが 85% に届かない
    ['9 fps, the 2nd frame 33 ms longer', 9, 18, 2, 33, 0.25, [], [0.144]],
  ])('%s: PART-TARGET is not decided from the part that starts with the long frame', (_, fps, keyint, from, delay, expected, exceeding, short) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    // プレイリストを公開した時 (3 つ目のセグメントが完成した時) のプレイリスト
    let published = '';
    // from 番目以降のフレームの timestamp が delay ミリ秒遅れる (from - 1 番目のフレームが delay ミリ秒長い)
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
    // 公開した時のプレイリストには、長いフレームから始まる 1 番も載っている
    // 1 番には PART-TARGET を合わせないことがあるので、1 番だけは PART-TARGET を超えたり、85% に届かなかったりする
    // (RFC 8216bis 4.4.4.9 を守れないが、そのセグメントがプレイリストから外れればなくなる)
    const first = segments(published);
    expect(first.flatMap(({ parts }) => parts).filter((duration) => duration > target)).toStrictEqual(exceeding);
    expect(first.flatMap(({ parts }) => parts.slice(1, -1)).filter((duration) => duration < 0.85 * target)).toStrictEqual(short);
    // 最後のプレイリストに残っているのは映像が途切れた後のセグメントだけ
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

  // 長いフレームから始まるものでも、その長さに合わせた PART-TARGET で、いつも通りのパーシャルセグメントが 85% に届くなら、PART-TARGET はそれより短くしない
  // (そのパーシャルセグメントも、公開したプレイリストに載っている)
  test.each([
    // 1 番は長いフレームと次のフレーム (0.202 秒、2 フレーム): PART-TARGET を 0.203 秒にしても、3 フレーム (0.2 秒) は 85% 以上
    ['15 fps, the 3rd frame 68 ms longer', 15, 30, 3, 68, 0.203],
    // 1 番は長いフレームだけ (0.202 秒、1 フレーム)
    ['15 fps, the 2nd frame 136 ms longer', 15, 30, 2, 136, 0.203],
  ])('%s: the part that starts with the long frame stays within PART-TARGET if the regular parts are still at least 85% of it', (_, fps, keyint, from, delay, expected) => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    // from 番目以降のフレームの timestamp が delay ミリ秒遅れる (from - 1 番目のフレームが delay ミリ秒長い)
    // 3 つ目のセグメントが完成して、プレイリストを公開するところまで入れる
    for (let i = 0; i <= keyint * 3; i++) {
      const timestamp = PlaylistTimestamp.fromRTMP(Math.round(i * 1000 / fps) + (i >= from ? delay : 0));
      const keyframe = i % keyint === 0;
      if (keyframe) { playlist.append(timestamp); }
      playlist.feed([Buffer.from([i % 256])], timestamp, true, keyframe);
    }

    const m3u8 = playlist.m3u8();
    const target = partTarget(m3u8);
    expect(target).toStrictEqual(expected);
    // 長いフレームのあるセグメントも載っている
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
    // OBS などは timestamp をミリ秒に切り捨てて送る (12 fps なら 0, 83, 166, 250, ...)
    // 3 フレーム目だけが 33 ミリ秒 (1 つ前のフレームの 1.4 倍ほど) 長いと、0 番は 2 フレーム (0.166 秒) で短く区切り、1 番は長いフレームと次のフレーム (0.2 秒、2 フレーム) になる
    // 1 番から決めると PART-TARGET が 0.201 秒になり、いつも通りの 2 フレーム (0.166 秒か 0.167 秒) のパーシャルセグメントがどれも 85% に届かない
    for (let i = 0; i < 24 * 8; i++) {
      const timestamp = PlaylistTimestamp.fromRTMP(Math.floor(i * 1000 / 12) + (i >= 3 ? 33 : 0));
      const keyframe = i % 24 === 0;
      if (keyframe) { playlist.append(timestamp); }
      playlist.feed([Buffer.from([i % 256])], timestamp, true, keyframe);
    }

    const m3u8 = playlist.m3u8();
    const target = partTarget(m3u8);
    // その後のいつも通りの 3 フレーム (0.25 秒) から決める
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

  test('PART-TARGET decided after a part cut short is not shorter than that part', () => {
    const playlist = new MediaPlaylist({ partialSegmentDuration: 0.25 });
    // 23.976 fps の映像 (48 フレームごとにキーフレーム) で、最初の 12 フレームの timestamp が数ミリ秒揺れている
    // 0 番のパーシャルセグメント (5 フレーム、0.210 秒) は、次のフレームが 1 つ前のフレームと同じ長さなら入ったので、短く区切ったものとして PART-TARGET を決めず、
    // 1 番 (5 フレーム、0.208 秒) で決める。その PART-TARGET が 0 番より短いと、0 番が PART-TARGET を超えてしまう
    // (1 番の最初のフレームは 1 つ前のフレームより 3 ミリ秒長いが、timestamp が揺れただけなので、映像が途切れた時のように 1 番を飛ばしたりはしない。
    //  飛ばして 2 番 (揺れでたまたま 6 フレーム入った 0.249 秒) で決めると、PART-TARGET が 0.25 秒のままになり、5 フレームのパーシャルセグメントが 85% に届かない)
    const jittered = [0, 43, 85, 128, 171, 210, 252, 294, 335, 376, 418, 461];
    // 3 つ目のセグメントが完成して、プレイリストを公開するところまで入れる
    for (let i = 0; i <= 48 * 3; i++) {
      const timestamp = PlaylistTimestamp.fromRTMP(jittered[i] ?? Math.round(i * 1001 / 24));
      const keyframe = i % 48 === 0;
      if (keyframe) { playlist.append(timestamp); }
      playlist.feed([Buffer.from([i % 256])], timestamp, true, keyframe);
    }

    const m3u8 = playlist.m3u8();
    const target = partTarget(m3u8);
    // 1 番 (0.208 秒) と 0 番 (0.210 秒) の長い方に 1 ミリ秒を足したもの
    expect(target).toStrictEqual(0.211);
    const list = segments(m3u8);
    expect(list.length).toStrictEqual(3);
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

  // パーシャルセグメントは 1 フレームより短くできないので、フレームの間隔が PART-TARGET より長いと、PART-TARGET を 1 フレームの長さ (と 1 ミリ秒) にする
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
