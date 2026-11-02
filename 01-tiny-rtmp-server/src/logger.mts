import { inspect, styleText } from 'node:util';

import { load } from './rtmp-session.mts';

export const LogLevel = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5,
} as const;

export interface Logger {
  trace(message: string, record?: Record<string, unknown>): void;
  debug(message: string, record?: Record<string, unknown>): void;
  info(message: string, record?: Record<string, unknown>): void;
  warn(message: string, record?: Record<string, unknown>): void;
  error(message: string, record?: Record<string, unknown>): void;
  fatal(message: string, record?: Record<string, unknown>): void;
}

export class NoopLogger implements Logger {
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
}

const flat = (obj: unknown): string => {
  return inspect(obj, {
    depth: Number.POSITIVE_INFINITY,
    breakLength: Number.POSITIVE_INFINITY,
    compact: true,
  });
};

const datetime = (): string => {
  const now = Temporal.Now.plainDateTimeISO();
  const time = now.toPlainTime().toString({ smallestUnit: 'millisecond' });
  return `${now.year}/${now.month}/${now.day} ${time}`;
};

type Level = keyof typeof LogLevel;
const styles = {
  TRACE: ['gray', 'bgBlack', 'dim'],
  DEBUG: ['gray', 'bgBlack'],
  INFO: ['white', 'bgBlack'],
  WARN: ['white', 'bgYellow'],
  ERROR: ['white', 'bgRed'],
  FATAL: ['white', 'bgRed', 'bold'],
} as const satisfies Record<Level, Parameters<typeof styleText>[0]>;

export class ConsoleLogger implements Logger {
  private loglevel: number;
  public constructor(loglevel?: number) {
    this.loglevel = loglevel ?? LogLevel.INFO;
  }

  private log(level: Level, message: string, record?: Record<string, unknown>): void {
    if (this.loglevel > LogLevel[level]) { return; }
    const label = styleText(styles[level], `[${level}]`, { stream: process.stderr });
    const merged = { ... load(), ... record };
    if (Object.keys(merged).length === 0) {
      console.error(datetime(), label, message);
    } else {
      console.error(datetime(), label, message, flat(merged));
    }
  }

  trace(message: string, record?: Record<string, unknown>): void {
    this.log('TRACE', message, record);
  }

  debug(message: string, record?: Record<string, unknown>): void {
    this.log('DEBUG', message, record);
  }

  info(message: string, record?: Record<string, unknown>): void {
    this.log('INFO', message, record);
  }

  warn(message: string, record?: Record<string, unknown>): void {
    this.log('WARN', message, record);
  }

  error(message: string, record?: Record<string, unknown>): void {
    this.log('ERROR', message, record);
  }

  fatal(message: string, record?: Record<string, unknown>): void {
    this.log('FATAL', message, record);
  }
}

let secret: Logger = new NoopLogger();
export const registerLogger = (logger: Logger): void => {
  secret = logger;
};

export const logger: Logger = {
  trace: (message, record) => { secret.trace(message, record); },
  debug: (message, record) => { secret.debug(message, record); },
  info: (message, record) => { secret.info(message, record); },
  warn: (message, record) => { secret.warn(message, record); },
  error: (message, record) => { secret.error(message, record); },
  fatal: (message, record) => { secret.fatal(message, record); },
};
