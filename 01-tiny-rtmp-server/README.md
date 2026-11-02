# RTMP受信サーバ

教育向けの小さいRTMP受信サーバの実装です。

## 主要コンポーネント

- async-byte-reader.mts - 非同期バイトストリーム読み取り
- byte-reader.mts / byte-builder.mts - 同期バイト操作ユーティリティ
- message-reader.mts / message-writer.mts - RTMPメッセージプロトコル処理
- amf0-reader.mts / amf0-writer.mts - AMF0フォーマットのシリアライゼーション
- flv-writer.mts - FLV (Flash Video) フォーマット出力

## 実行方法

Node.js のネイティブTypeScript実行機能により、以下のコマンドで実行できます。

```bash
# デフォルトポート（1935）でサーバーを起動
node src/index.mts

# カスタムポートでサーバーを起動
node src/index.mts --port 8080

# FLVファイルに出力 (配信が始まるたびに作り直します)
node src/index.mts --flv output.flv

# 標準出力にFLVデータを出力
node src/index.mts --flv -

# 送受信したRTMPのメッセージを標準エラー出力にログとして出力
node src/index.mts --intercept
```

また、vite を使ってバンドルして javascript にまとめられます。

```bash
# dist/tiny-rtmp-server.js (CommonJS), dist/tiny-rtmp-server.mjs (ES Modules) にバンドルした結果を出力
yarn build
```

