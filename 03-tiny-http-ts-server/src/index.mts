import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';
import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';

import handle_rtmp from '../../02-tiny-http-flv-server/src/rtmp-accepter.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

import MPEGTSTransmuxer from './mpegts-transmuxer.mts';
import { TimestampUnwrapper } from './rtmp-handler.mts';

const options = {
  rtmp: {
    type: 'string',
    default: '1935',
  },
  web: {
    type: 'string',
    default: '8000',
  },
  app: {
    type: 'string',
  },
  streamKey: {
    type: 'string',
  },
  highWaterMark: {
    type: 'string',
  },
  bandwidth: {
    type: 'string',
  },
} as const satisfies ParseArgsOptionsConfig;
const { values: args } = parseArgs({ options });
const port = Number.parseInt(args.rtmp, 10);
const web = Number.parseInt(args.web, 10);
const highWaterMark = args.highWaterMark != null ? Number.parseInt(args.highWaterMark, 10) : undefined;
const bandwidth = args.bandwidth != null ? Number.parseInt(args.bandwidth, 10) : undefined;
if (Number.isNaN(port) || Number.isNaN(web)) {
  console.error('Please Specify valid port number'); process.exit(1);
}
if (args.app == null) {
  console.error('Please Specify valid app'); process.exit(1);
}
if (args.streamKey == null) {
  console.error('Please Specify valid streamKey'); process.exit(1);
}
if (Number.isNaN(highWaterMark)) {
  console.error('Please Specify valid highwatermark'); process.exit(1);
}
if (Number.isNaN(bandwidth)) {
  console.error('Please Specify valid bandwidth'); process.exit(1);
}
const app = args.app;
const streamKey = args.streamKey;
const auth = AuthConfiguration.simpleAuth(app, streamKey);
registerLogger(new ConsoleLogger());

// 配信の始めに、PMT に載せる ES が決まるのを待つ長さ (最初の映像・音声のメッセージの timestamp からのミリ秒) と、その間に溜めるメッセージの数の上限
// (onMetaData を送ってこない配信で、届かないトラックがある時などはいつまでも決まらないので、ずっとは待たない。06 の UNDECLARED_TRACK_WAIT, MAX_WAITING_FRAMES と同じ)
const DECISION_WAIT = 1000;
const MAX_PENDING_MESSAGES = 1000;

type Viewer = {
  write: (buffer: Buffer) => void;
  exit: () => void;
  checking: boolean; // 送信が詰まっていないかを、この tick の終わりに確かめることにしたか
  initialBytes: number; // 配信の始めに、PMT に載せる ES が決まるのを待っていた間の分をまとめて送ったバイト数
};
const viewers = new Set<Viewer>();

const handle = async (connection: Duplex) => {
  const rtmp_to_mpegts = new MPEGTSTransmuxer();
  // RTMP の timestamp が一周して戻っても (rtmp-handler.mts の TimestampUnwrapper)、時刻が戻らないように直してから使う
  // (そのままだと、FFmpeg の 31bit の timestamp が一周した時や負の DTS (0x7FFFFFxx) で PTS/DTS が 2^32 (90kHz で約 13 時間) 飛ぶ。
  //  また時刻が戻ると、PAT/PMT/PCR を出力する間隔を測れなくなり、それらが出力されなくなる)
  const timestamps = new TimestampUnwrapper();
  let published = false;
  // 配信の始めは、PMT に載せる ES が決まるまで (MPEGTSTransmuxer の decided)、feed が返したもの (取り出す時に TS パケットにする) を溜めておく
  // (PAT/PMT は取り出す時に出力するので、決まってから順に取り出すと、最初の PMT から決まった ES だけが載る。FFmpeg も、入力を調べてから PMT を決める。
  //  決まる前に出力した PMT に、後から載せないと分かった ES が載っていると、version_number を増やした PMT で外しても、mpegts.js などはその ES のデータを待って再生を始めない)
  const pending: Iterable<Buffer>[] = [];
  let waiting = true;
  // 最初の映像・音声のメッセージの timestamp (待った長さを測る)
  let first: number | null = null;
  // 溜めていたものから順に TS パケットにして、視聴者に送る
  const send = (): void => {
    const packets = pending.splice(0).flatMap((iterable) => [... iterable]);
    if (waiting) {
      // 待っていた間の分は、待っていた視聴者にまとめて送ることになる (速い視聴者でも送り終わるまでに時間がかかるので、その分は詰まりとみなさない)
      const bytes = packets.reduce((sum, packet) => sum + packet.byteLength, 0);
      for (const viewer of viewers) { viewer.initialBytes = bytes; }
      waiting = false;
    }
    for (const packet of packets) {
      for (const viewer of viewers) { viewer.write(packet); }
    }
  };

  try {
    for await (const received of handle_rtmp(connection, { auth, limit: { bandwidth } })) {
      published = true;
      const message = timestamps.unwrap(received);
      pending.push(rtmp_to_mpegts.feed(message));
      if (waiting) {
        // 待った長さは映像・音声のメッセージの timestamp で測る (onMetaData の timestamp は、映像・音声と同じ時計とは限らない)
        let waited = false;
        if (message.message_type_id === MessageType.Video || message.message_type_id === MessageType.Audio) {
          first ??= message.timestamp;
          waited = message.timestamp - first >= DECISION_WAIT;
        }
        // ES が決まるか、DECISION_WAIT だけ待つか、MAX_PENDING_MESSAGES 個溜まるまで待つ
        if (!rtmp_to_mpegts.decided() && !waited && pending.length < MAX_PENDING_MESSAGES) { continue; }
      }
      send();
    }
  } catch (e) {
    logger.error('RTMP session error', { error: e });
  } finally {
    // 配信していた接続が終わったら視聴も終わらせる (認証に失敗した接続などでは何もしない)
    if (published) {
      // ES が決まる前に配信が終わったら、溜めていた分を送ってから終わらせる
      send();
      for (const viewer of viewers) { viewer.exit(); }
    }
  }
};

const rtmp_server = net.createServer({ noDelay: true }, (connection) => {
  run(() => handle(connection));
});
rtmp_server.listen(port);

const web_server = http.createServer({ highWaterMark }, (req, res) => {
  // new URL は解析できない URL (例: //[) だと例外を投げてサーバごと落ちるので、代わりに null を返す URL.parse を使う
  const url = URL.parse(req.url ?? '/', `http://localhost:${web}`);
  if (url == null || !(req.method === 'GET' && url.pathname === `/${app}/${streamKey}`)) {
    res.writeHead(404, { 'access-control-allow-origin': '*' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': 'video/mp2t',
    'access-control-allow-origin': '*',
  });

  const viewer: Viewer = {
    write: (chunk: Buffer) => {
      if (res.closed) { return; }
      res.write(chunk);
      if (highWaterMark == null || viewer.checking) { return; }
      // highWaterMark を超えて送信が詰まっている視聴者は切断する
      // ただし Node.js の http は、同じ tick に書いたデータを tick の終わりにまとめて送るので、それまでは全て writableLength に数えられる
      // (1 つの tick に何メッセージ分も書くと、詰まっていなくても highWaterMark を超え、res.write も false を返す)
      // そこで tick の終わりに送った後 (setImmediate) に、まだ送れずに残っているバイト数で確かめる (配信が終わって end した後は、残りを送り終わるまで待つ)
      viewer.checking = true;
      setImmediate(() => {
        viewer.checking = false;
        if (!res.writableEnded && res.writableLength > highWaterMark + viewer.initialBytes) { res.destroy(); }
      });
    },
    exit: () => { res.end(); viewers.delete(viewer); },
    checking: false,
    initialBytes: 0,
  };
  viewers.add(viewer);

  req.on('close', viewer.exit);
  res.on('close', viewer.exit);
  req.on('error', viewer.exit);
  res.on('error', viewer.exit);
});
web_server.listen({ port: web });
