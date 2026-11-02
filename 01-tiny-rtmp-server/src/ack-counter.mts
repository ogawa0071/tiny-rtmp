// 受信バイト数を数え、Window Acknowledgement Size ごとに Acknowledgement を送るタイミングを通知する
export default class AckCounter {
  private total: number = 0; // 受信した総バイト数 (32bit で一周する)
  private difference: number = 0; // 前回通知してから受信したバイト数
  private ack_window_size: number | null = null;
  private callback: (bytes: number) => void;

  public constructor(callback: (bytes: number) => void = () => {}) {
    this.callback = callback;
  }

  private call(): void {
    if (this.ack_window_size == null) { return; }
    if (this.ack_window_size > this.difference) { return; }
    this.callback(this.total);
    this.difference = 0;
  }

  public feed(byteLength: number): void {
    this.difference += byteLength;
    this.total = (this.total + byteLength) % 2 ** 32;
    this.call();
  }

  public window(ack_window_size: number): void {
    this.ack_window_size = ack_window_size;
    this.call();
  }
}
