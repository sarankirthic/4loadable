/** Generic concurrency-limiting FIFO job queue (no DOM/chrome deps). */

export class ThumbnailQueueCancelledError extends Error {
  constructor() {
    super('Thumbnail queue job cancelled: cancelAll() was called before this job started.');
    this.name = 'ThumbnailQueueCancelledError';
  }
}

interface QueueEntry {
  run(): Promise<void>;
  cancel(): void;
}

export function createThumbnailQueue(concurrency = 4): {
  schedule<T>(job: () => Promise<T>): Promise<T>;
  cancelAll(): void;
} {
  const pending: QueueEntry[] = [];
  let active = 0;

  function pump(): void {
    while (active < concurrency && pending.length > 0) {
      const entry = pending.shift()!;
      active++;
      void entry.run().finally(() => {
        active--;
        pump();
      });
    }
  }

  function schedule<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.push({
        run: () => job().then(resolve, reject),
        cancel: () => reject(new ThumbnailQueueCancelledError()),
      });
      pump();
    });
  }

  function cancelAll(): void {
    const toCancel = pending.splice(0, pending.length);
    for (const entry of toCancel) entry.cancel();
  }

  return { schedule, cancelAll };
}
