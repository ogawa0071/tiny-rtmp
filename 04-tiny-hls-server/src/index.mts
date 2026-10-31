import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import handle_rtmp from '../../02-tiny-http-flv-server/src/rtmp-accepter.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

import HLSGenerator from './hls-generator.mts';

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
  bandwidth: {
    type: 'string',
  },
  maxage: {
    type: 'string',
  },
} as const satisfies ParseArgsOptionsConfig;
const { values: args } = parseArgs({ options });
const port = Number.parseInt(args.rtmp, 10);
const web = Number.parseInt(args.web, 10);
const bandwidth = args.bandwidth != null ? Number.parseInt(args.bandwidth, 10) : undefined;
const maxage = args.maxage != null ? Number.parseInt(args.maxage, 10) : 36000;
if (Number.isNaN(port) || Number.isNaN(web)) {
  console.error('Please Specify valid port number'); process.exit(1);
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
const app = args.app;
const streamKey = args.streamKey;
const auth = AuthConfiguration.simpleAuth(app, streamKey);
registerLogger(new ConsoleLogger());

const page = `
<!DOCTYPE html>
<html>
  <body>
    <video id="video" controls></video>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
    <script>
      function init() {
        const video = document.querySelector("video");
        const url = "./playlist.m3u8";
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
        } else if (Hls.isSupported()) {
          const player = new Hls();
          player.loadSource(url);
          player.attachMedia(video);
        }
      }
      init();
    </script>
  </body>
</html>
`.trimStart();

let rtmp_to_hls: HLSGenerator | null = null;
const handle = async (connection: Duplex) => {
  // この接続の配信で作った HLSGenerator (認証に失敗した接続などが終了しても、配信中のものを消さないようにする)
  let generator: HLSGenerator | null = null;
  try {
    for await (const message of handle_rtmp(connection, { auth, limit: { bandwidth } })) {
      if (generator == null) {
        generator = new HLSGenerator(3);
        rtmp_to_hls = generator;
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

const rtmp_server = net.createServer({ noDelay: true }, (connection) => {
  run(() => handle(connection));
});
rtmp_server.listen(port);

const web_server = http.createServer(async (req, res) => {
  const respond = (status: number, headers: Record<string, string>, body: string | Buffer = '') => {
    res.writeHead(status, { 'access-control-allow-origin': '*', ... headers });
    res.end(body);
  };

  // new URL は解析できない URL (例: //[) だと例外を投げてサーバごと落ちるので、代わりに null を返す URL.parse を使う
  const url = URL.parse(req.url ?? '/', `http://localhost:${web}`);
  const directory = `/${app}/${streamKey}/`;
  // await している間に配信が終わって差し替わっても大丈夫なように、今の配信の HLSGenerator を取り出しておく
  const generator = rtmp_to_hls;
  if (url == null || !(req.method === 'GET' && url.pathname.startsWith(directory)) || generator == null) {
    respond(404, {});
    return;
  }

  const filename = url.pathname.slice(directory.length);
  if (filename === '' || filename === 'index.html') {
    respond(200, { 'content-type': 'text/html', 'cache-control': 'max-age=0' }, page);
    return;
  }
  if (filename === 'playlist.m3u8') {
    // セグメントが揃ってプレイリストを公開できるようになるまで待つ
    if (!await generator.published()) {
      respond(404, {});
      return;
    }
    respond(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'max-age=0' }, generator.m3u8());
    return;
  }
  const ts = /^(\d+)\.ts$/.exec(filename);
  if (ts != null) {
    const [, msn] = ts;
    const segment = generator.segment(Number.parseInt(msn, 10));
    if (segment == null) {
      respond(404, { 'cache-control': 'max-age=0' });
      return;
    }
    respond(200, { 'content-type': 'video/mp2t', 'cache-control': `max-age=${maxage}` }, segment);
    return;
  }

  respond(404, {});
});
web_server.listen({ port: web });
