import { EventEmitter } from 'node:events';
import type { ServerEvent } from '../../shared/types.js';

class Bus extends EventEmitter {
  publish(event: ServerEvent) {
    this.emit('event', event);
  }
  notice(level: 'info' | 'warn' | 'error', message: string) {
    this.publish({ type: 'notice', level, message });
  }
}

export const bus = new Bus();
bus.setMaxListeners(200);
