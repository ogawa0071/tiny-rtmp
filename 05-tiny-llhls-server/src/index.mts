import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import handle_rtmp from '../../02-tiny-http-flv-server/src/rtmp-accepter.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

import LLHLSGenerator from './llhls-generator.mts';

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
        if (Hls.isSupported()) {
          const player = new Hls();
          player.loadSource(url);
          player.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
        }
      }
      init();
    </script>
  </body>
</html>
`.trimStart();

let rtmp_to_llhls: LLHLSGenerator | null = null;
const handle = async (connection: Duplex) => {
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

  const url = URL.parse(req.url ?? '/', `http://localhost:${web}`);
  const directory = `/${app}/${streamKey}/`;
  const generator = rtmp_to_llhls;
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
    const integer = /^\d+$/;
    if (msn == null || !integer.test(msn) || (part != null && !integer.test(part)) || generator.tooFar(Number(msn), part == null ? null : Number(part))) {
      respond(400, { 'cache-control': 'max-age=0' });
      return;
    }
    if (!await generator.block(Number(msn), part == null ? null : Number(part))) {
      respond(503, { 'cache-control': 'max-age=0' });
      return;
    }
    respond(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': `max-age=${maxage}` }, generator.m3u8());
    return;
  }
  const ts = /^(\d+)(?:_(\d+))?\.ts$/.exec(filename);
  if (ts != null) {
    const [, msn, part] = ts;
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
