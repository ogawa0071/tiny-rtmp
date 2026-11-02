import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import type MPEGTSTransmuxer from './mpegts-transmuxer.mts';

export const DECISION_WAIT = 1000;
export const MAX_PENDING_MESSAGES = 1000;

export type Output = { packets: Buffer[]; released: boolean; };

export default class DecisionWait {
  private transmuxer: MPEGTSTransmuxer;
  private pending: Iterable<Buffer>[] = [];
  private waiting = true;
  private first: number | null = null;

  public constructor(transmuxer: MPEGTSTransmuxer) {
    this.transmuxer = transmuxer;
  }

  public feed(message: Message): Output {
    this.pending.push(this.transmuxer.feed(message));
    if (this.waiting) {
      let waited = false;
      if (message.message_type_id === MessageType.Video || message.message_type_id === MessageType.Audio) {
        this.first ??= message.timestamp;
        waited = message.timestamp - this.first >= DECISION_WAIT;
      }
      if (!this.transmuxer.decided() && !waited && this.pending.length < MAX_PENDING_MESSAGES) { return { packets: [], released: false }; }
    }
    return this.flush();
  }

  public flush(): Output {
    const packets = this.pending.splice(0).flatMap((iterable) => [... iterable]);
    const released = this.waiting;
    this.waiting = false;
    return { packets, released };
  }
}
