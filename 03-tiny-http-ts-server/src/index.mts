import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import handle_rtmp from '../../02-tiny-http-flv-server/src/rtmp-accepter.mts';
import { congestion_checker } from '../../02-tiny-http-flv-server/src/congestion.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

import MPEGTSTransmuxer from './mpegts-transmuxer.mts';
import DecisionWait from './decision-wait.mts';
import type { Output } from './decision-wait.mts';
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

type Viewer = {
  write: (buffer: Buffer) => void;
  exit: () => void;
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
  // 配信の始めは、PMT に載せる ES が決まるまで (1 秒まで) 待ってから TS パケットにする (decision-wait.mts)
  const wait = new DecisionWait(rtmp_to_mpegts);
  // 送れるようになった TS パケットを、1 つの Buffer につなげてから視聴者に送る
  // (Node.js は 1 つの tick に書いた Buffer を tick の終わりにまとめて OS に渡すが、1 回の writev で渡せる数には上限 (Linux では 1024 個) があり、2 回渡しても残った分は後のイベントループで渡す。
  //  TS パケット (188 バイト) ごとに書くと、大きなキーフレームや待っていた間の分などで 1 つの tick に 2000 個より多く書いた時に、残りを渡し終わるまでは全て writableLength に数えられ、
  //  速い視聴者でも highWaterMark を超えて切断してしまう: congestion.mts)
  const send = ({ packets, released }: Output): void => {
    const data = Buffer.concat(packets);
    // 待っていた間の分は、待っていた視聴者にまとめて送ることになる (速い視聴者でも送り終わるまでに時間がかかるので、その分は詰まりとみなさない: congestion.mts)
    if (released) {
      for (const viewer of viewers) { viewer.initialBytes = data.byteLength; }
    }
    // TS パケットにならないメッセージ (初期化情報や onMetaData など) では何も書かない
    if (data.byteLength === 0) { return; }
    for (const viewer of viewers) { viewer.write(data); }
  };

  try {
    for await (const message of handle_rtmp(connection, { auth, limit: { bandwidth } })) {
      published = true;
      send(wait.feed(timestamps.unwrap(message)));
    }
  } catch (e) {
    logger.error('RTMP session error', { error: e });
  } finally {
    // 配信していた接続が終わったら視聴も終わらせる (認証に失敗した接続などでは何もしない)
    if (published) {
      // ES が決まる前に配信が終わったら、溜めていた分を送ってから終わらせる
      send(wait.flush());
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

  // highWaterMark を超えて送信が詰まっている視聴者は切断する (同じ tick に書いた分を送った後に確かめる: congestion.mts)
  // (配信の始めに、PMT に載せる ES が決まるのを待っていた間の分をまとめて送った視聴者は、その分を詰まりとみなさない)
  const check_congestion = congestion_checker(res, highWaterMark, () => viewer.initialBytes);
  const viewer: Viewer = {
    write: (chunk: Buffer) => {
      if (res.closed) { return; }
      res.write(chunk);
      check_congestion();
    },
    exit: () => { res.end(); viewers.delete(viewer); },
    initialBytes: 0,
  };
  viewers.add(viewer);

  req.on('close', viewer.exit);
  res.on('close', viewer.exit);
  req.on('error', viewer.exit);
  res.on('error', viewer.exit);
});
web_server.listen({ port: web });
