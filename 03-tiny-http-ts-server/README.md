# HTTP-TS配信サーバ

[HTTP-FLV配信サーバ](../02-tiny-http-flv-server/)と似た形で MPEG-TS へトランスマックスして HTTP-TS 配信に対応させた実装です。

## 主要コンポーネント

- mpegts-transmuxer.mts - FLVからMPEG-TSへの変換処理 (PMT には、映像 (H.264) と音声 (AAC) のうち、データの届く ES を載せる。トラックごとに、最初に届いたメッセージのコーデックで決め、まだ届いていなければ onMetaData で決める。onMetaData がない時や、onMetaData にコーデックが書かれていない時は、届くまで分からないので載せておく (そのトラックが届かない配信 (FFmpeg の -vn や -an に -flvflags no_metadata を付けた時など) では、データの届かない ES が載ったままになる)。載せずに PMT を出力した ES は、後からそのトラックが届いても載せない。HTTP-TS 配信 (index.mts) は、配信の始めは PMT に載せる ES が決まるまで (1 秒まで) 待ってから送る)
- mpegts.mts - MPEG-TSフォーマットのパケット生成
- aac.mts / avc.mts - AACとAVCコーデックの処理
- bit-reader.mts / bit-builder.mts - ビットレベルでのデータ操作ユーティリティ
- rtmp-handler.mts - RTMPの映像/音声/データメッセージの中身の解析と、一周して戻る timestamp (RTMP は 32bit, FFmpeg は 31bit) を一周しない時刻に直す処理 (このサーバと、04 以降の HLS, fMP4, DASH のサーバで使う)

## 実行方法

Node.js のネイティブTypeScript実行機能により、以下のコマンドで実行できます。

```bash
# RTMPポート1935、HTTPポート8000でサーバーを起動
node src/index.mts --app myapp --streamKey mystreamkey

# カスタムポートでサーバーを起動
node src/index.mts --rtmp 1935 --web 8080 --app myapp --streamKey mystreamkey

# 帯域幅制限付きで起動
node src/index.mts --app myapp --streamKey mystreamkey --bandwidth 2000000

# バッファサイズを指定
node src/index.mts --app myapp --streamKey mystreamkey --highWaterMark 16384
```

また、vite を使ってバンドルして javascript にまとめられます。

```bash
# dist/tiny-http-ts-server.js (CommonJS), dist/tiny-http-ts-server.mjs (ES Modules) にバンドルした結果を出力
yarn build
```

## 利用方法

デフォルトの設定の場合、以下のURLで利用可能です。

### RTMP打ち上げ先
```
rtmp://localhost:1935/myapp/mystreamkey
```

### HTTP-TSでの視聴URL
```
http://localhost:8000/myapp/mystreamkey
```
