import { EventEmitter } from 'node:events';
import type { ServerEvent } from '../../shared/types.js';

class Bus extends EventEmitter {
  publish(event: ServerEvent) {
    this.emit('event', event);
  }
  private recent = new Map<string, number>();
  /** Toast for every open browser. The same message is not repeated within 60 s (polling loops re-raise warnings). */
  notice(level: 'info' | 'warn' | 'error', message: string) {
    const key = `${level}:${message}`;
    const now = Date.now();
    if ((this.recent.get(key) ?? 0) > now - 60_000) return;
    this.recent.set(key, now);
    if (this.recent.size > 200) for (const [k, t] of this.recent) if (t < now - 60_000) this.recent.delete(k);
    this.publish({ type: 'notice', level, message });
  }
}

export const bus = new Bus();
bus.setMaxListeners(200);
