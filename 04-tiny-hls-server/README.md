# HLS配信サーバ

[HTTP-TS配信サーバ](../03-tiny-http-ts-server/)を改修してHLS配信に対応させた実装です。

## 主要コンポーネント

- hls-generator.mts - [HTTP-TS配信](../03-tiny-http-ts-server/)のMPEG-TSをキーフレームで区切り、HLSのセグメントにする処理 (onMetaData から映像 (H.264) のない配信と分かれば、音声のフレームで 1 秒以上ごとに区切る)
- media-playlist.mts - M3U8プレイリストファイル生成
- segment.mts - MPEG-TSセグメント管理
- index.mts - RTMPとHTTPサーバの統合管理

## 実行方法

Node.js のネイティブTypeScript実行機能により、以下のコマンドで実行できます。

```bash
# RTMPポート1935、HTTPポート8000でサーバーを起動
node src/index.mts --app myapp --streamKey mystreamkey

# カスタムポートでサーバーを起動
node src/index.mts --rtmp 1935 --web 8080 --app myapp --streamKey mystreamkey

# 帯域幅制限付きで起動
node src/index.mts --app myapp --streamKey mystreamkey --bandwidth 2000000
```

また、vite を使ってバンドルして javascript にまとめられます。

```bash
# dist/tiny-hls-server.js (CommonJS), dist/tiny-hls-server.mjs (ES Modules) にバンドルした結果を出力
yarn build
```

## 利用方法

デフォルトの設定の場合、以下のURLで利用可能です。

### RTMP打ち上げ先
```
rtmp://localhost:1935/myapp/mystreamkey
```

### HLS視聴URL (プレイリスト)
```
http://localhost:8000/myapp/mystreamkey/playlist.m3u8
```

### TSセグメント
```
http://localhost:8000/myapp/mystreamkey/{番号}.ts
```

セグメントの番号は配信を始めた時刻 (UNIX 時間を 0.1 秒単位にしたもの) から始まります (前の配信の番号がそれより進んでいれば、その続きから)。配信し直しても前の配信と URL が重ならないようにするためです。
