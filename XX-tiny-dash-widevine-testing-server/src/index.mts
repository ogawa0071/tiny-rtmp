import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import handle_rtmp from '../../02-tiny-http-flv-server/src/rtmp-accepter.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

import DASHGenerator from './dash-generator.mts';
import { EncryptionFormat } from '../../08-tiny-dash-cenc-server/src/cenc.mts';

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
  encryptionScheme: {
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
if (args.encryptionScheme !== 'cenc' && args.encryptionScheme !== 'cbcs') {
  console.error('Please Specify valid encryptionScheme'); process.exit(1);
}
if (Number.isNaN(bandwidth)) {
  console.error('Please Specify valid bandwidth'); process.exit(1);
}
if (Number.isNaN(maxage)) {
  console.error('Please Specify valid maxage'); process.exit(1);
}
const app = args.app;
const streamKey = args.streamKey;
const encryptionFormat = EncryptionFormat.from(args.encryptionScheme);
const auth = AuthConfiguration.simpleAuth(app, streamKey);

// Widevine のテスト用 KID/Key を用いる
const encryptionKeyId = Buffer.from('90351951686b5e1ba222439ecec1f12a', 'hex');
const encryptionKey = Buffer.from('0a237b0752cbf1a827e2fecfb87479a2', 'hex');
registerLogger(new ConsoleLogger());

const page = `
<!DOCTYPE html>
<html>
  <body>
    <video id="video" controls></video>
    <script src="https://cdn.dashjs.org/latest/modern/umd/dash.all.min.js"></script>
    <!-- <script src="https://cdn.dashjs.org/latest/modern/umd/dash.all.debug.js"></script> -->
    <script>
      function init() {
        const protData = {
          "com.widevine.alpha": {
            "serverURL": "https://cwip-shaka-proxy.appspot.com/no_auth"
          }
        };
        const video = document.querySelector("video");
        const url = "./manifest.mpd";
        const player = dashjs.MediaPlayer().create();
        /*
        player.updateSettings({
          'debug': {
              'logLevel': dashjs.Debug.LOG_LEVEL_DEBUG
          }
        });
        //*/
        player.initialize(video, url, true);
        player.setProtectionData(protData);
      }
      init();
    </script>
  </body>
</html>
`.trimStart();

let rtmp_to_dash: DASHGenerator | null = null;
const handle = async (connection: Duplex) => {
  // この接続の配信で作った DASHGenerator (認証に失敗した接続などが終了しても、配信中のものを消さないようにする)
  let generator: DASHGenerator | null = null;
  try {
    for await (const message of handle_rtmp(connection, { auth, limit: { bandwidth } })) {
      if (generator == null) {
        generator = new DASHGenerator(encryptionFormat, encryptionKeyId, encryptionKey, 3);
        rtmp_to_dash = generator;
      }
      generator.feed(message);
    }
  } catch (e) {
    logger.error('RTMP session error', { error: e });
  } finally {
    if (rtmp_to_dash === generator) { rtmp_to_dash = null; }
  }
};

const rtmp_server = net.createServer({ noDelay: true }, (connection) => {
  run(() => handle(connection));
});
rtmp_server.listen(port);

const web_server = http.createServer((req, res) => {
  const respond = (status: number, headers: Record<string, string>, body: string | Buffer = '') => {
    res.writeHead(status, { 'access-control-allow-origin': '*', ... headers });
    res.end(body);
  };

  // new URL は解析できない URL (例: //[) だと例外を投げてサーバごと落ちるので、代わりに null を返す URL.parse を使う
  const url = URL.parse(req.url ?? '/', `http://localhost:${web}`);
  const directory = `/${app}/${streamKey}/`;
  const generator = rtmp_to_dash;
  if (url == null || !(req.method === 'GET' && url.pathname.startsWith(directory)) || generator == null) {
    respond(404, {});
    return;
  }

  const filename = url.pathname.slice(directory.length);
  if (filename === '' || filename === 'index.html') {
    respond(200, { 'content-type': 'text/html', 'cache-control': 'max-age=0' }, page);
    return;
  }
  if (filename === 'manifest.mpd') {
    const mpd = generator.mpd();
    // 最初のセグメントができるまでは MPD を作れないので、配信が始まっていない時と同じく 404 を返す
    if (mpd == null) {
      respond(404, { 'cache-control': 'max-age=0' });
      return;
    }
    respond(200, { 'content-type': 'application/dash+xml', 'cache-control': 'max-age=0' }, mpd);
    return;
  }
  // 初期化セグメントは {video|audio}_{session}_init.mp4, セグメントは {video|audio}_{session}_{番号}.m4s
  // (session は配信ごとに変わるので、前の配信で同じ URL をキャッシュした視聴者にも今の配信の中身が届く)
  const mp4 = /^(video|audio)_(\d+)_(?:init\.mp4|(\d+)\.m4s)$/.exec(filename);
  if (mp4 != null) {
    const [, type, session, msn] = mp4;
    const segment = session !== generator.session ? null : msn == null ? generator.initialize(type) : generator.segment(type, Number.parseInt(msn, 10));
    if (segment == null) {
      respond(404, { 'cache-control': 'max-age=0' });
      return;
    }
    respond(200, { 'content-type': `${type}/mp4`, 'cache-control': `max-age=${maxage}` }, segment);
    return;
  }

  respond(404, {});
});
web_server.listen({ port: web });
