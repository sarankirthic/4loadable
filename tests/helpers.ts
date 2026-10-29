import type { DownloadsPort, QueueEnv } from '../src/background/queue-manager.ts';
import { MemoryKV } from '../src/shared/storage.ts';
import type { DownloadSnapshot, NewQueueItem } from '../src/shared/types.ts';

export class FakeDownloads implements DownloadsPort {
  nextId = 1;
  all = new Map<number, DownloadSnapshot & { url: string; filename: string }>();
  startCalls: string[] = [];
  failStart: ((url: string) => string | null) | null = null;
  async start(o: { url: string; filename: string }) {
    const err = this.failStart?.(o.url);
    if (err) throw new Error(err);
    const id = this.nextId++;
    this.startCalls.push(o.url);
    this.all.set(id, { id, state: 'in_progress', paused: false, bytesReceived: 0, totalBytes: 100, url: o.url, filename: '/dl/' + o.filename });
    return id;
  }
  async pause(id: number) { this.all.get(id)!.paused = true; }
  async resume(id: number) { this.all.get(id)!.paused = false; }
  async cancel(id: number) { const d = this.all.get(id); if (d) { d.state = 'interrupted'; d.error = 'USER_CANCELED'; } }
  async query(ids: number[]) { return ids.map((i) => this.all.get(i)).filter(Boolean).map((d) => ({ ...d! })); }
  complete(id: number) { const d = this.all.get(id)!; d.state = 'complete'; d.bytesReceived = 100; }
  interrupt(id: number, error: string) { const d = this.all.get(id)!; d.state = 'interrupted'; d.error = error; }
  byUrl(url: string) { return [...this.all.values()].find((d) => d.url === url)!; }
}

export class FakeClock {
  t = 1_000_000;
  timers: { at: number; fn: () => void; id: number }[] = [];
  seq = 0;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.push({ at: this.t + ms, fn, id }); return id; };
  clearTimer = (h: unknown) => { this.timers = this.timers.filter((x) => x.id !== h); };
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
      await tick();
    }
    this.t = end;
  }
}
export const tick = () => new Promise<void>((r) => setImmediate(r));
export const settle = async (n = 5) => { for (let i = 0; i < n; i++) await tick(); };

export function makeEnv(extra: Partial<QueueEnv> = {}) {
  const kv = new MemoryKV();
  const downloads = new FakeDownloads();
  const clock = new FakeClock();
  const env: QueueEnv = { kv, downloads, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...extra };
  return { kv, downloads, clock, env };
}

export const entry = (n: number, o: Partial<NewQueueItem> = {}): NewQueueItem => ({
  id: `g:${1700000000000 + n}`, url: `https://i.4cdn.org/g/${1700000000000 + n}.png`, path: `dl/g/1/images/f${n}.png`,
  type: 'image', site: 'fourchan', board: 'g', threadId: '1', postNo: String(n), originalName: `f${n}.png`, ext: 'png',
  conflict: 'uniquify', saveAs: false, batchId: 'b1', ...o,
});
