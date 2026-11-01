# LL-HLS配信サーバ

[HLS配信サーバ](../04-tiny-hls-server/)にLL-HLS配信機能を付け加えた実装です。

## 主要コンポーネント

- llhls-generator.mts - LL-HLSプレイリストとセグメント生成処理
- concatenated-segment.mts, segment.mts - パーシャルセグメントを含めたセグメント管理
- media-playlist.mts - M3U8プレイリストファイル生成

## 実行方法

Node.js のネイティブTypeScript実行機能により、以下のコマンドで実行できます。

```bash
# RTMPポート1935、HTTPポート8000でサーバーを起動
node src/index.mts --app myapp --streamKey mystreamkey

# カスタムポートでサーバーを起動
node src/index.mts --rtmp 1935 --web 8080 --app myapp --streamKey mystreamkey

# 帯域幅制限付きで起動
node src/index.mts --app myapp --streamKey mystreamkey --bandwidth 2000000

# パーシャルセグメント長を指定
node src/index.mts --app myapp --streamKey mystreamkey --partDuration 0.3
```

また、vite を使ってバンドルして javascript にまとめられます。

```bash
# dist/tiny-llhls-server.js (CommonJS), dist/tiny-llhls-server.mjs (ES Modules) にバンドルした結果を出力
yarn build
```

## 利用方法

デフォルトの設定の場合、以下のURLで利用可能です。

### RTMP打ち上げ先
```
rtmp://localhost:1935/myapp/mystreamkey
```

### LL-HLS視聴URL (プレイリスト)
```
http://localhost:8000/myapp/mystreamkey/playlist.m3u8
```

### TSセグメント
```
http://localhost:8000/myapp/mystreamkey/{番号}.ts
```

セグメントの番号は配信を始めた時刻 (UNIX 時間を 0.1 秒単位にしたもの) から始まります (前の配信の番号がそれより進んでいれば、その続きから)。配信し直しても前の配信と URL が重ならないようにするためです。

### パーシャルセグメント
```
http://localhost:8000/myapp/mystreamkey/{セグメント番号}_{パート番号}.ts
```

パーシャルセグメントは映像のフレームの境目で区切ります。パーシャルセグメントには、次の決まりがあります。

- 長さは PART-TARGET 以下で、INDEPENDENT=YES のものとセグメントの最後のもの以外は PART-TARGET の 85% 以上 (RFC 8216bis 4.4.4.9)
- 1 つ前のパーシャルセグメントをプレイリストに追加してから PART-TARGET 以内に、次のパーシャルセグメントを追加する (RFC 8216bis 6.2.1)

フレームの長さは次のフレームが届くまで分からないので、フレームがパーシャルセグメントに入るかどうかは、ふつうは次のフレームが届いてから決めます。ただし、それを待つと 1 つ前のパーシャルセグメントを追加してから PART-TARGET を過ぎてしまう時は、直前のフレームの間隔からフレームの長さを見積もって、フレームが届いた時に区切ります。

`--partDuration` のままでは 85% に届かないパーシャルセグメントができるかもしれない時は、最初にセグメントの途中でいつも通りに区切ったパーシャルセグメントの長さに 1 ミリ秒を足したものを PART-TARGET にします。RTMP の timestamp はミリ秒に丸められていて、同じフレーム数でも 1 ミリ秒長くなったり短くなったりするので、そのずれも考えて決めます (考えるのはこのずれだけなので、timestamp がそれ以上に揺れる配信では 85% に届かないこともあります)。PART-TARGET はプレイリストを公開するまでに決めて、その後は変えません。

- 15 fps で `--partDuration 0.25` なら、3 フレーム (0.2 秒、80%) ごとに区切って、PART-TARGET を 0.201 秒にします。
- 24 fps で `--partDuration 0.25` なら、6 フレームでちょうど 0.25 秒ですが、PART-TARGET を 0.251 秒にします。6 フレームが 0.251 秒になることもある 23.976 fps とは最初のパーシャルセグメントだけでは見分けられず、23.976 fps で 0.25 秒のままだと 5 フレーム (85% 未満) で区切ることがあるからです。
- フレームが欠けたり映像が途切れたりして短く区切ったパーシャルセグメントからは決めません (配信の始めに映像が 1 秒止まっても、PART-TARGET が 1 フレームの長さになったりはしません)。
- パーシャルセグメントは 1 フレームより短くは区切れないので、フレームの間隔が `--partDuration` より長い (フレームレートが低い) 時は、PART-TARGET を 1 フレームの長さ (と 1 ミリ秒) にします (例: 2 fps で `--partDuration 0.25` なら、1 フレーム (0.5 秒) ごとに区切って、PART-TARGET を 0.501 秒にします)。
