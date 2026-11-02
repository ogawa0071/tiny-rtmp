import type { ServerResponse } from 'node:http';

// highWaterMark を超えて送信が詰まっている視聴者を切断する関数を、視聴者のレスポンスごとに作る (res.write で書いた後に呼ぶ。03, 06 のサーバでも使う)
// initialBytes は、視聴を始めた時などにまとめて送ったバイト数 (その分は詰まりとみなさない: 下)
export const congestion_checker = (res: ServerResponse, highWaterMark: number | undefined, initialBytes: () => number = () => 0): () => void => {
  // 送信が詰まっていないかを、この tick の終わりに確かめることにしたか
  let checking = false;
  return () => {
    if (highWaterMark == null || checking) { return; }
    // Node.js の http は、同じ tick に書いたデータを tick の終わりにまとめて送るので、それまでは全て writableLength に数えられる
    // (大きなキーフレームや、配信の始めなどにまとめて届いたメッセージを 1 つの tick に書くと、詰まっていなくても highWaterMark を超え、res.write も false を返す)
    // そこで tick の終わりに送った後 (setImmediate) に、writableLength で確かめる (同じ tick に何度書いても、確かめるのは 1 度だけ。配信が終わって end した後は、残りを送り終わるまで待つ)
    // (writableLength は、まとめて送ったデータを OS が全部受け取るまで、受け取った分も含めて全部数え、その後に書いた分も数える。
    //  送り始めたばかりの TCP 接続は送信バッファが小さく、一度に少ししか受け取らないので、ネットワーク越しの視聴者は速くても、配信の始めなどに highWaterMark を超えて切断されることがある)
    // 視聴を始めた時にまとめて送ったデータは、速い視聴者でも送り終わるまでに時間がかかるので、詰まりとみなさない
    // (それを OS が全部受け取るまでは、その間に届いたフレームも後ろに溜まって数えられる。配信の速さについて来られる視聴者なら、
    //  まとめて送ったデータを受け取る間に溜まるのは、それと同じくらいの量までなので、合わせて 2 倍までは詰まりとみなさない)
    checking = true;
    setImmediate(() => {
      checking = false;
      if (!res.writableEnded && res.writableLength > highWaterMark + 2 * initialBytes()) { res.destroy(); }
    });
  };
};
