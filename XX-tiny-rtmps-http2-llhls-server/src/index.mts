import tls from 'node:tls';
import http2 from 'node:http2';
import fs from 'node:fs';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import handle_rtmp from '../../02-tiny-http-flv-server/src/rtmp-accepter.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

import LLHLSGenerator from '../../05-tiny-llhls-server/src/llhls-generator.mts';

const options = {
  rtmp: {
    type: 'string',
    default: '1935',
  },
  web: {
    type: 'string',
    default: '8000',
  },
  key: {
    type: 'string',
  },
  cert: {
    type: 'string',
  },
  app: {
    type: 'string',
  },
  streamKey: {
    type: 'string',
  },
  bandwidth: {
    type: 'string',
  },
  maxage: {
    type: 'string',
  },
  partDuration: {
    type: 'string',
  },
} as const satisfies ParseArgsOptionsConfig;
const { values: args } = parseArgs({ options });
const port = Number.parseInt(args.rtmp, 10);
const web = Number.parseInt(args.web, 10);
const bandwidth = args.bandwidth != null ? Number.parseInt(args.bandwidth, 10) : undefined;
const maxage = args.maxage != null ? Number.parseInt(args.maxage, 10) : 36000;
const partDuration = args.partDuration != null ? Number.parseFloat(args.partDuration) : undefined;
if (Number.isNaN(port) || Number.isNaN(web)) {
  console.error('Please Specify valid port number'); process.exit(1);
}
if (args.key == null) {
  console.error('Please Specify Valid SSL/TLS key'); process.exit(1);
}
if (args.cert == null) {
  console.error('Please Specify Valid SSL/TLS cert'); process.exit(1);
}
if (args.app == null) {
  console.error('Please Specify valid app'); process.exit(1);
}
if (args.streamKey == null) {
  console.error('Please Specify valid streamKey'); process.exit(1);
}
if (Number.isNaN(bandwidth)) {
  console.error('Please Specify valid bandwidth'); process.exit(1);
}
if (Number.isNaN(maxage)) {
  console.error('Please Specify valid maxage'); process.exit(1);
}
if (Number.isNaN(partDuration)) {
  console.error('Please Specify valid partDuration'); process.exit(1);
}
const key = fs.readFileSync(args.key);
const cert = fs.readFileSync(args.cert);
const app = args.app;
const streamKey = args.streamKey;
const auth = AuthConfiguration.simpleAuth(app, streamKey);
registerLogger(new ConsoleLogger());

let rtmp_to_llhls: LLHLSGenerator | null = null;
const handle = async (connection: Duplex) => {
  // この接続の配信で作った LLHLSGenerator (認証に失敗した接続などが終了しても、配信中のものを消さないようにする)
  let generator: LLHLSGenerator | null = null;
  try {
    for await (const message of handle_rtmp(connection, { auth, limit: { bandwidth } })) {
      if (generator == null) {
        generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: partDuration });
        rtmp_to_llhls = generator;
      }
      generator.feed(message);
    }
  } catch (e) {
    logger.error('RTMP session error', { error: e });
  } finally {
    // 配信が終わっても、EXT-X-ENDLIST を付けたプレイリストとセグメントは次の配信が始まるまで返し続ける
    // (プレイリストに載せたセグメントは、視聴者が取得できるようにしておく必要がある: RFC 8216 6.2.1)
    generator?.end();
  }
};

const rtmp_server = tls.createServer({ noDelay: true, key, cert }, (connection) => {
  run(() => handle(connection));
});
rtmp_server.listen(port);

// HTTP/2 に対応していない視聴者も (低遅延ではない通常の HLS として) 視聴できるように、HTTP/1.1 も受け付ける
const web_server = http2.createSecureServer({ key, cert, allowHTTP1: true }, async (req, res) => {
  const respond = (status: number, headers: Record<string, string>, body: string | Buffer = '') => {
    res.writeHead(status, { 'access-control-allow-origin': '*', ... headers });
    res.end(body);
  };

  // new URL は解析できない URL (例: //[) だと例外を投げてサーバごと落ちるので、代わりに null を返す URL.parse を使う
  const url = URL.parse(req.url ?? '/', `http://localhost:${web}`);
  const directory = `/${app}/${streamKey}/`;
  // await している間に配信が終わって差し替わっても大丈夫なように、今の配信の LLHLSGenerator を取り出しておく
  const generator = rtmp_to_llhls;
  if (url == null || !(req.method === 'GET' && url.pathname.startsWith(directory)) || generator == null) {
    respond(404, {});
    return;
  }

  const filename = url.pathname.slice(directory.length);
  if (filename === 'playlist.m3u8') {
    // セグメントが揃ってプレイリストを公開できるようになるまで待つ
    if (!await generator.published()) {
      respond(404, {});
      return;
    }

    const msn = url.searchParams.get('_HLS_msn');
    const part = url.searchParams.get('_HLS_part');
    if (msn == null && part == null) {
      respond(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'max-age=0' }, generator.m3u8());
      return;
    }
    // Blocking Playlist Reload: _HLS_msn (と _HLS_part) で指定された (パーシャル) セグメントが載るまで待ってから返す (RFC 8216bis 6.2.5.2)
    // _HLS_part だけの指定、0 以上の整数でない値、先すぎる指定には 400 Bad Request を返す
    const integer = /^\d+$/;
    if (msn == null || !integer.test(msn) || (part != null && !integer.test(part)) || generator.tooFar(Number(msn), part == null ? null : Number(part))) {
      respond(400, { 'cache-control': 'max-age=0' });
      return;
    }
    // Target Duration の 3 倍待っても載らなければ 503 Service Unavailable を返す
    if (!await generator.block(Number(msn), part == null ? null : Number(part))) {
      respond(503, { 'cache-control': 'max-age=0' });
      return;
    }
    respond(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': `max-age=${maxage}` }, generator.m3u8());
    return;
  }
  // セグメントは {msn}.ts, パーシャルセグメントは {msn}_{part}.ts
  const ts = /^(\d+)(?:_(\d+))?\.ts$/.exec(filename);
  if (ts != null) {
    const [, msn, part] = ts;
    // 作成中の (パーシャル) セグメントは、完成するまで待ってからまとめて返す (RFC 8216bis 6.2.6)
    const data = await generator.get(Number.parseInt(msn, 10), part == null ? null : Number.parseInt(part, 10));
    if (data == null) {
      respond(404, { 'cache-control': 'max-age=0' });
      return;
    }
    respond(200, { 'content-type': 'video/mp2t', 'cache-control': `max-age=${maxage}` }, data);
    return;
  }

  respond(404, {});
});
web_server.listen({ port: web });
