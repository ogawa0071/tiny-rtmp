import tls from 'node:tls';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import handle_rtmp from '../../01-tiny-rtmp-server/src/rtmp-accepter.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';
import intercepter from '../../01-tiny-rtmp-server/src/rtmp-intercepter.mts';
import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, LogLevel, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

const options = {
  port: {
    type: 'string',
    default: '1935',
  },
  key: {
    type: 'string',
  },
  cert: {
    type: 'string',
  },
  flv: {
    type: 'string',
  },
  intercept: {
    type: 'boolean',
    default: false,
  },
} as const satisfies ParseArgsOptionsConfig;
const { values: args } = parseArgs({ options });
const port = Number.parseInt(args.port, 10);
if (Number.isNaN(port)) {
  console.error('Please Specify Valid PORT number');
  process.exit(1);
}
if (args.key == null) {
  console.error('Please Specify Valid SSL/TLS key');
  process.exit(1);
}
if (args.cert == null) {
  console.error('Please Specify Valid SSL/TLS cert');
  process.exit(1);
}
const flv = args.flv;
const intercept = args.intercept;
const key = fs.readFileSync(args.key);
const cert = fs.readFileSync(args.cert);
const auth = AuthConfiguration.noAuth();
const open_flv = flv == null ? undefined : () => flv === '-' ? process.stdout : fs.createWriteStream(flv);
registerLogger(new ConsoleLogger(intercept ? LogLevel.DEBUG : LogLevel.INFO));

const server = tls.createServer({ noDelay: true, key, cert }, (connection) => {
  run(async () => {
    try {
      const proxy = intercept ? intercepter(connection) : connection;
      await handle_rtmp(proxy, auth, open_flv);
    } catch (e) {
      logger.error('RTMP session error', { error: e });
    }
  });
});
server.listen(port);
