import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import handle_rtmp from '../../02-tiny-http-flv-server/src/rtmp-accepter.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

import FMP4Transmuxer from './fmp4-transmuxer.mts';

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

type Viewer = {
  write: (buffer: Buffer) => void;
  exit: () => void;
  initialized: boolean; // 初期化セグメントを送ったか
  checking: boolean; // 送信が詰まっていないかを、この tick の終わりに確かめることにしたか
  initialBytes: number; // 視聴を始めた時にまとめて送ったバイト数 (初期化セグメントと、待っている間に取っておいたフレームを含む断片)
};
const viewers = new Set<Viewer>();

const handle = async (connection: Duplex) => {
  const rtmp_to_fmp4 = new FMP4Transmuxer();
  let published = false;

  try {
    for await (const message of handle_rtmp(connection, { auth, limit: { bandwidth } })) {
      published = true;
      // 初期化セグメントを作った時は、それまで待っていたフレームの断片もまとめて返ってくる
      const fragments = rtmp_to_fmp4.feed(message);
      for (const [index, fragment] of fragments.entries()) {
        for (const viewer of viewers) {
          // 視聴を始めた視聴者には、最初に初期化セグメントを送る
          // 映像は、キーフレームから送り始める (それより前のフレームは、参照するフレームがないのでデコードできない)
          if (!viewer.initialized) {
            const initialize = rtmp_to_fmp4.initialize();
            if (initialize == null || !fragment.independent) { continue; }
            // 初期化セグメントと、ここから後の断片はまとめて送ることになる
            viewer.initialBytes = fragments.slice(index).reduce((bytes, { data }) => bytes + data.byteLength, initialize.byteLength);
            viewer.write(initialize);
            viewer.initialized = true;
          }
          viewer.write(fragment.data);
        }
      }
    }
  } catch (e) {
    logger.error('RTMP session error', { error: e });
  } finally {
    // 配信していた接続が終わったら視聴も終わらせる (認証に失敗した接続などでは何もしない)
    if (published) {
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
  // データは初期化セグメントが揃ってから (映像のキーフレームから) 送るので、レスポンスヘッダだけ先に送る
  res.writeHead(200, {
    'content-type': 'video/mp4',
    'access-control-allow-origin': '*',
  });
  res.flushHeaders();

  const viewer: Viewer = {
    write: (chunk: Buffer) => {
      if (res.closed) { return; }
      res.write(chunk);
      if (highWaterMark == null || viewer.checking) { return; }
      // highWaterMark を超えて送信が詰まっている視聴者は切断する
      // ただし Node.js の http は、同じ tick に書いたデータを tick の終わりにまとめて送るので、それまでは全て writableLength に数えられる
      // (配信の始めなどにメッセージがまとめて届くと、1 つの tick に何フレーム分も書くので、詰まっていなくても highWaterMark を超える)
      // そこで tick の終わりに送った後 (setImmediate) に、まだ送れずに残っているバイト数で確かめる (配信が終わって end した後は、残りを送り終わるまで待つ)
      // (視聴を始めた時にまとめて送ったデータは、速い視聴者でも送り終わるまでに時間がかかるので、その分は詰まりとみなさない)
      viewer.checking = true;
      setImmediate(() => {
        viewer.checking = false;
        if (!res.writableEnded && res.writableLength > highWaterMark + viewer.initialBytes) { res.destroy(); }
      });
    },
    exit: () => { res.end(); viewers.delete(viewer); },
    initialized: false,
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
