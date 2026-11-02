export class BandwidthQuotaExceededError extends Error {
  constructor(message: string, option?: ErrorOptions) {
    super(message, option);
    this.name = this.constructor.name;
  }
}

export type BandwidthEstimatorOption = {
  intervalMillis: number;
  movingAverageLength: number;
};
export const BandwidthEstimatorOption = {
  from(option?: Partial<BandwidthEstimatorOption>): BandwidthEstimatorOption {
    return {
      intervalMillis: option?.intervalMillis ?? 100,
      movingAverageLength: option?.movingAverageLength ?? 10,
    };
  },
};

export default class BandwidthEstimator {
  private limit: number;
  private controller: AbortController;
  private movingAverageLength: number;
  private timer: NodeJS.Timeout;
  private estimates: number[] = [];
  private totalBytes: number = 0;
  private previousTime: number = performance.now();

  public constructor(limit: number, controller: AbortController, option?: Partial<BandwidthEstimatorOption>) {
    const { intervalMillis, movingAverageLength } = BandwidthEstimatorOption.from(option);
    this.limit = limit;
    this.controller = controller;
    this.movingAverageLength = movingAverageLength;
    this.timer = setInterval(() => { this.measure(); }, intervalMillis);
  }

  public feed(byteLength: number) {
    this.totalBytes += byteLength;
  }

  public estimate(): number {
    return this.estimates.reduce((sum, curr) => sum + curr, 0) / this.estimates.length;
  }

  public measure(): void {
    const currentTime = performance.now();
    const duration = (currentTime - this.previousTime) / 1000;
    this.estimates.push((this.totalBytes * 8) / duration);
    this.previousTime = currentTime;
    this.totalBytes = 0;

    if (this.estimates.length < this.movingAverageLength) { return; }
    this.estimates.splice(0, this.estimates.length - this.movingAverageLength);
    const average = this.estimate();
    if (average >= this.limit) {
      this.controller.abort(new BandwidthQuotaExceededError(`Bandwidth quota exceeded! limit: ${this.limit}bps, actual: ${Math.ceil(average)}bps`));
    }
  }

  public destroy(): void {
    clearInterval(this.timer);
  }
  public [Symbol.dispose](): void {
    this.destroy();
  }
}
