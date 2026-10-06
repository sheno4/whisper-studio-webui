export class TaskSlotLimiter {
  private active = 0;
  private limit: number;
  private readonly waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort: () => void;
  }> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.pump();
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Task cancelled'));
        return;
      }
      const entry = {
        resolve, reject, signal,
        abort: () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          signal?.removeEventListener('abort', entry.abort);
          reject(new Error('Task cancelled'));
        }
      };
      this.waiting.push(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.limit && this.waiting.length) {
      const entry = this.waiting.shift()!;
      entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) {
        entry.reject(new Error('Task cancelled'));
        continue;
      }
      this.active++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
  }
}
