import { classifyInterrupt, classifyStartError } from '../shared/download-errors';
import type { KV } from '../shared/storage';
import type { DownloadSnapshot, NewQueueItem, QueueItem, QueueStatus } from '../shared/types';

export const ACTIVE: QueueStatus[] = ['starting', 'downloading', 'paused'];
export const TERMINAL: QueueStatus[] = ['complete', 'failed', 'skipped', 'cancelled'];

const ALLOWED: Record<QueueStatus, QueueStatus[]> = {
  queued: ['starting', 'cancelled', 'skipped'],
  starting: ['downloading', 'queued', 'failed', 'cancelled', 'complete'],
  downloading: ['paused', 'complete', 'failed', 'queued', 'cancelled'],
  paused: ['downloading', 'complete', 'failed', 'queued', 'cancelled'],
  complete: ['queued'],
  failed: ['queued'],
  cancelled: ['queued'],
  skipped: ['queued'],
};
export const canTransition = (from: QueueStatus, to: QueueStatus) => from === to || ALLOWED[from].includes(to);

/** Thin port over chrome.downloads so the queue can be tested without a browser. */
export interface DownloadsPort {
  start(o: { url: string; filename: string; conflictAction: 'uniquify' | 'prompt' | 'overwrite'; saveAs: boolean }): Promise<number>;
  pause(id: number): Promise<void>;
  resume(id: number): Promise<void>;
  cancel(id: number): Promise<void>;
  query(ids: number[]): Promise<DownloadSnapshot[]>;
}

export interface QueueEnv {
  kv: KV;
  downloads: DownloadsPort;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  onFinished?(item: QueueItem): void;
  onChange?(): void;
}

export interface QueueConfig { maxConcurrent: number; maxRetries: number; retryBaseMs: number }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class QueueManager {
  readonly items = new Map<string, QueueItem>();
  paused = false;
  private persistTimer: unknown = null;
  private pumpTimer: unknown = null;
  private busy = false;
  private again = false;

  constructor(private env: QueueEnv, public cfg: QueueConfig) {}

  async init(): Promise<void> {
    const s = await this.env.kv.get(['queue', 'queuePaused']);
    for (const it of (s.queue ?? []) as QueueItem[]) this.items.set(it.id, it);
    this.paused = !!s.queuePaused;
    await this.reconcile();
  }

  /** Re-sync persisted state with what the browser says after a service-worker restart. */
  async reconcile(): Promise<void> {
    const active = [...this.items.values()].filter((i) => ACTIVE.includes(i.status));
    const ids = active.map((i) => i.downloadId).filter((x): x is number => x != null);
    const snaps = new Map((ids.length ? await this.env.downloads.query(ids) : []).map((s) => [s.id, s]));
    for (const it of active) {
      if (it.downloadId == null) { it.downloadId = undefined; this.set(it, 'queued'); continue; }
      const snap = snaps.get(it.downloadId);
      if (snap) this.applySnapshot(it, snap);
      else this.finishFailed(it, 'The browser no longer has a record of this download.', 'RECORD_MISSING');
    }
    await this.flush();
    void this.pump();
  }

  enqueue(entries: NewQueueItem[]): { added: number; duplicates: number } {
    let added = 0, duplicates = 0;
    const now = this.env.now();
    for (const e of entries) {
      const ex = this.items.get(e.id);
      if (ex && !TERMINAL.includes(ex.status)) { duplicates++; continue; }
      this.items.delete(e.id);
      this.items.set(e.id, { ...e, status: 'queued', attempts: 0, addedAt: now, updatedAt: now });
      added++;
    }
    this.changed();
    void this.pump();
    return { added, duplicates };
  }

  // ---------- scheduling ----------
  countActive(): number {
    let n = 0;
    for (const i of this.items.values()) if (ACTIVE.includes(i.status)) n++;
    return n;
  }

  async pump(): Promise<void> {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try { do { this.again = false; await this.pumpOnce(); } while (this.again); } finally { this.busy = false; }
  }

  private async pumpOnce(): Promise<void> {
    if (this.paused) return;
    const now = this.env.now();
    let active = this.countActive();
    let wake = Infinity;
    const starts: QueueItem[] = [];
    for (const it of this.items.values()) {
      if (it.status !== 'queued') continue;
      if (it.notBefore && it.notBefore > now) { wake = Math.min(wake, it.notBefore); continue; }
      if (active >= this.cfg.maxConcurrent) break;
      this.set(it, 'starting');
      active++;
      starts.push(it);
    }
    await Promise.all(starts.map((it) => this.startItem(it)));
    if (wake < Infinity) this.schedulePump(wake - now);
  }

  private schedulePump(ms: number) {
    if (this.pumpTimer) this.env.clearTimer(this.pumpTimer);
    this.pumpTimer = this.env.setTimer(() => { this.pumpTimer = null; void this.pump(); }, Math.max(0, ms));
  }

  private async startItem(it: QueueItem): Promise<void> {
    try {
      const id = await this.env.downloads.start({ url: it.url, filename: it.path, conflictAction: it.conflict, saveAs: it.saveAs });
      if (it.status !== 'starting') { await this.env.downloads.cancel(id).catch(() => {}); return; } // cancelled mid-start
      it.downloadId = id;
      this.touch(it);
      const [snap] = await this.env.downloads.query([id]); // covers events that fired before we knew the id
      if (snap) this.applySnapshot(it, snap);
      else this.set(it, 'downloading');
    } catch (e) {
      const c = classifyStartError(errMsg(e));
      this.handleFailure(it, c.transient, c.message, 'START_FAILED');
    }
  }

  // ---------- reconciling browser events ----------
  async onDownloadChanged(downloadId: number): Promise<void> {
    const it = [...this.items.values()].find((i) => i.downloadId === downloadId && ACTIVE.includes(i.status));
    if (!it) return;
    const [snap] = await this.env.downloads.query([downloadId]);
    if (snap) this.applySnapshot(it, snap);
  }

  /** Poll progress for active downloads (the downloads API has no progress event). Returns true if any are active. */
  async poll(): Promise<boolean> {
    const active = [...this.items.values()].filter((i) => ACTIVE.includes(i.status) && i.downloadId != null);
    if (!active.length) return false;
    const snaps = new Map((await this.env.downloads.query(active.map((i) => i.downloadId!))).map((s) => [s.id, s]));
    for (const it of active) { const s = snaps.get(it.downloadId!); if (s) this.applySnapshot(it, s); }
    return this.countActive() > 0;
  }

  applySnapshot(it: QueueItem, snap: DownloadSnapshot): void {
    if (!ACTIVE.includes(it.status)) return;
    it.bytes = snap.bytesReceived;
    it.total = snap.totalBytes > 0 ? snap.totalBytes : it.total;
    if (snap.filename) it.savedPath = snap.filename;
    if (snap.state === 'complete') { it.error = undefined; this.set(it, 'complete'); return; }
    if (snap.state === 'interrupted') {
      if (snap.error === 'USER_CANCELED') { this.set(it, 'cancelled'); return; }
      const c = classifyInterrupt(snap.error);
      this.handleFailure(it, c.transient, c.message, snap.error);
      return;
    }
    this.set(it, snap.paused ? 'paused' : 'downloading');
  }

  private handleFailure(it: QueueItem, transient: boolean, message: string, code?: string) {
    if (transient && it.attempts < this.cfg.maxRetries) {
      it.attempts++;
      it.downloadId = undefined;
      it.error = message;
      it.errorCode = code;
      it.notBefore = this.env.now() + this.cfg.retryBaseMs * 2 ** (it.attempts - 1);
      this.set(it, 'queued');
      this.schedulePump(it.notBefore - this.env.now());
    } else this.finishFailed(it, message, code);
  }

  private finishFailed(it: QueueItem, message: string, code?: string) {
    it.error = message;
    it.errorCode = code;
    this.set(it, 'failed');
  }

  // ---------- state machine ----------
  private touch(it: QueueItem) { it.updatedAt = this.env.now(); this.changed(); }

  set(it: QueueItem, to: QueueStatus): boolean {
    if (!canTransition(it.status, to)) return false;
    const wasActive = ACTIVE.includes(it.status);
    it.status = to;
    if (to === 'queued') { it.bytes = undefined; it.total = undefined; } else it.notBefore = undefined;
    this.touch(it);
    if (TERMINAL.includes(to)) {
      if (to !== 'cancelled') { try { this.env.onFinished?.(it); } catch { /* never let observers break the queue */ } }
      void this.flush();
    }
    if (wasActive && !ACTIVE.includes(to)) void this.pump();
    return true;
  }

  // ---------- user controls ----------
  async pauseItem(id: string) {
    const it = this.items.get(id);
    if (!it || it.status !== 'downloading' || it.downloadId == null) return;
    try { await this.env.downloads.pause(it.downloadId); } catch { return; }
    this.set(it, 'paused');
  }

  async resumeItem(id: string) {
    const it = this.items.get(id);
    if (!it || it.status !== 'paused' || it.downloadId == null) return;
    try { await this.env.downloads.resume(it.downloadId); } catch (e) {
      // Not resumable (e.g. interrupted): fall back to a fresh attempt.
      it.downloadId = undefined; this.set(it, 'queued'); void this.pump(); return;
    }
    this.set(it, 'downloading');
  }

  async cancelItem(id: string) {
    const it = this.items.get(id);
    if (!it || TERMINAL.includes(it.status)) return;
    if (it.downloadId != null && it.status !== 'queued') await this.env.downloads.cancel(it.downloadId).catch(() => {});
    this.set(it, 'cancelled');
  }

  retryItem(id: string): boolean {
    const it = this.items.get(id);
    if (!it || !['failed', 'cancelled', 'skipped'].includes(it.status)) return false;
    it.attempts = 0; it.error = undefined; it.errorCode = undefined; it.downloadId = undefined; it.savedPath = undefined;
    const ok = this.set(it, 'queued');
    void this.pump();
    return ok;
  }

  retryFailed(): number {
    let n = 0;
    for (const it of [...this.items.values()]) if (it.status === 'failed' && this.retryItem(it.id)) n++;
    return n;
  }

  async cancelAll() { for (const it of [...this.items.values()]) await this.cancelItem(it.id); }

  async pauseAll() {
    this.paused = true;
    await this.env.kv.set({ queuePaused: true });
    for (const it of this.items.values()) if (it.status === 'downloading') await this.pauseItem(it.id);
  }

  async resumeAll() {
    this.paused = false;
    await this.env.kv.set({ queuePaused: false });
    for (const it of [...this.items.values()]) if (it.status === 'paused') await this.resumeItem(it.id);
    void this.pump();
  }

  clearFinished() {
    for (const [id, it] of this.items) if (['complete', 'skipped', 'cancelled'].includes(it.status)) this.items.delete(id);
    this.changed();
  }

  stats(): Record<QueueStatus, number> & { total: number } {
    const s = { queued: 0, starting: 0, downloading: 0, paused: 0, complete: 0, failed: 0, skipped: 0, cancelled: 0, total: 0 };
    for (const it of this.items.values()) { s[it.status]++; s.total++; }
    return s;
  }

  // ---------- persistence ----------
  private changed() {
    this.env.onChange?.();
    if (this.persistTimer) return;
    this.persistTimer = this.env.setTimer(() => { this.persistTimer = null; void this.flush(); }, 400);
  }

  async flush(): Promise<void> {
    if (this.persistTimer) { this.env.clearTimer(this.persistTimer); this.persistTimer = null; }
    try { await this.env.kv.set({ queue: [...this.items.values()], queuePaused: this.paused }); } catch (e) {
      console.warn('[queue] could not persist queue:', errMsg(e));
    }
  }
}
