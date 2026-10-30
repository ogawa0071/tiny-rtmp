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
    generator?.end();
    if (rtmp_to_llhls === generator) { rtmp_to_llhls = null; }
  }
};

const rtmp_server = tls.createServer({ noDelay: true, key, cert }, (connection) => {
  run(() => handle(connection));
});
rtmp_server.listen(port);

const web_server = http2.createSecureServer({ key, cert }, async (req, res) => {
  const respond = (status: number, headers: Record<string, string>, body: string | Buffer = '') => {
    res.writeHead(status, { 'access-control-allow-origin': '*', ... headers });
    res.end(body);
  };

  const url = new URL(req.url ?? '/', `http://localhost:${web}`);
  const directory = `/${app}/${streamKey}/`;
  // await している間に配信が終わって差し替わっても大丈夫なように、今の配信の LLHLSGenerator を取り出しておく
  const generator = rtmp_to_llhls;
  if (!(req.method === 'GET' && url.pathname.startsWith(directory)) || generator == null) {
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

    // Blocking Playlist Reload: _HLS_msn (と _HLS_part) で指定された (パーシャル) セグメントができるまで待ってから返す
    const msn = Number.parseInt(url.searchParams.get('_HLS_msn') ?? '', 10);
    const part = url.searchParams.has('_HLS_part') ? Number.parseInt(url.searchParams.get('_HLS_part')!, 10) : null;
    if (Number.isNaN(msn) || Number.isNaN(part)) {
      respond(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'max-age=0' }, generator.m3u8());
      return;
    }
    await generator.block(msn, part);
    respond(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': `max-age=${maxage}` }, generator.m3u8());
    return;
  }
  // セグメントは {msn}.ts, パーシャルセグメントは {msn}_{part}.ts
  const ts = /^(\d+)(?:_(\d+))?\.ts$/.exec(filename);
  if (ts != null) {
    const [, msn, part] = ts;
    // 作成中の (パーシャル) セグメントは、完成するまで書き込まれた分から順に返していく
    generator.stream(Number.parseInt(msn, 10), part == null ? null : Number.parseInt(part, 10), res, (found) => {
      if (found) {
        res.writeHead(200, { 'content-type': 'video/mp2t', 'access-control-allow-origin': '*', 'cache-control': `max-age=${maxage}` });
      } else {
        res.writeHead(404, { 'access-control-allow-origin': '*', 'cache-control': 'max-age=0' });
      }
    });
    return;
  }

  respond(404, {});
});
web_server.listen({ port: web });
