export const AuthResult = {
  OK: 'OK',
  RETRY: 'RETRY',
  DISCONNECT: 'DISCONNECT',
} as const;
export type AuthResult = (typeof AuthResult)[keyof typeof AuthResult];

export const strip_query = (value: string): string => {
  const query_index = value.indexOf('?');
  if (query_index < 0) { return value; }
  return value.slice(0, query_index);
};
export const collect_query = (value: string): Record<string, string> | undefined => {
  const query_index = value.indexOf('?');
  if (query_index < 0) { return undefined; }
  // URLSearchParams は '+' を空白に変換してしまい、Adobe Auth で扱う base64 の値が壊れるので、そのまま分割する
  return Object.fromEntries(value.slice(query_index + 1).split('&').map((pair) => {
    const index = pair.indexOf('=');
    return index >= 0 ? [pair.slice(0, index), pair.slice(index + 1)] : [pair, ''];
  }));
};

// 同じ app/stream に対して同時に複数の配信がされないようにするためのロック
export class PublishLock {
  private locked = new Set<string>();

  public acquire(app: string, stream: string): boolean {
    const key = `${app}/${stream}`;
    if (this.locked.has(key)) { return false; }
    this.locked.add(key);
    return true;
  }

  public release(app: string, stream: string): void {
    this.locked.delete(`${app}/${stream}`);
  }
}

type MaybePromise<T,> = T | Promise<T>;
export type AuthResultWithDescription = [authResult: AuthResult, description: string | null];
export interface AuthConfiguration {
  connect(app: string, query?: Record<string, string>): MaybePromise<AuthResultWithDescription>;
  publish(app: string, key: string, query?: Record<string, string>): MaybePromise<AuthResultWithDescription>;
  keepalive(app: string, key: string, query?: Record<string, string>): MaybePromise<typeof AuthResult.OK | typeof AuthResult.DISCONNECT>;
  disconnect(app: string, key: string, query?: Record<string, string>): MaybePromise<void>;
}
export const AuthConfiguration = {
  noAuth(): AuthConfiguration {
    const lock = new PublishLock();
    return {
      connect: () => [AuthResult.OK, null],
      publish: (app: string, key: string) => [lock.acquire(app, key) ? AuthResult.OK : AuthResult.DISCONNECT, null],
      keepalive: () => AuthResult.OK,
      disconnect: (app: string, key: string) => { lock.release(app, key); },
    };
  },
  simpleAuth(appName: string, streamKey: string): AuthConfiguration {
    const lock = new PublishLock();
    return {
      connect: (app: string) => [app === appName ? AuthResult.OK : AuthResult.DISCONNECT, null],
      publish: (app: string, key: string) => [key === streamKey && lock.acquire(app, key) ? AuthResult.OK : AuthResult.DISCONNECT, null],
      keepalive: () => AuthResult.OK,
      disconnect: (app: string, key: string) => { lock.release(app, key); },
    };
  },
  customAuth(
    connectFn: ((app: string, query?: Record<string, string>) => MaybePromise<boolean>) | null,
    publishFn: ((app: string, key: string, query?: Record<string, string>) => MaybePromise<boolean>) | null,
    keepaliveFn: ((app: string, key: string, query?: Record<string, string>) => MaybePromise<boolean>) | null,
    disconnectFn: ((app: string, key: string, query?: Record<string, string>) => MaybePromise<void>) | null
  ): AuthConfiguration {
    const lock = new PublishLock();
    return {
      connect: async (app: string, query?: Record<string, string>) => [(await connectFn?.(app, query) ?? true) ? AuthResult.OK : AuthResult.DISCONNECT, null],
      publish: async (app: string, key: string, query?: Record<string, string>) => {
        const ok = await publishFn?.(app, key, query) ?? true;
        return [ok && lock.acquire(app, key) ? AuthResult.OK : AuthResult.DISCONNECT, null];
      },
      keepalive: async (app: string, key: string, query?: Record<string, string>) => (await keepaliveFn?.(app, key, query) ?? true) ? AuthResult.OK : AuthResult.DISCONNECT,
      disconnect: async (app: string, key: string, query?: Record<string, string>) => {
        try {
          await disconnectFn?.(app, key, query);
        } finally {
          lock.release(app, key);
        }
      },
    };
  },
};
