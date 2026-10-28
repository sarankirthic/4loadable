import { mergeMedia } from '../shared/media-detection';
import type { KV } from '../shared/storage';
import { scanKey } from '../shared/messaging';
import type { IgnoredSummary, MediaItem, PageInfo, Progress, ScanState, ThreadSummary } from '../shared/types';

const MAX_SCANS = 8;

export const emptyScan = (tabId: number, page: PageInfo): ScanState => ({
  tabId, page, items: [], threads: [], scanning: false, errors: [], updatedAt: Date.now(),
});

/** Per-tab scan results in storage.session. All writes are serialized so batches never clobber each other. */
export class ScanStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private kv: KV) {}

  get(tabId: number): Promise<ScanState | null> {
    return this.kv.get(scanKey(tabId)).then((r) => (r[scanKey(tabId)] as ScanState) ?? null);
  }

  update(tabId: number, page: PageInfo, fn: (s: ScanState) => void): Promise<ScanState> {
    const run = async () => {
      let s = await this.get(tabId);
      if (!s) s = emptyScan(tabId, page);
      fn(s);
      s.updatedAt = Date.now();
      await this.kv.set({ [scanKey(tabId)]: s });
      return s;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async applyBatch(tabId: number, b: { page: PageInfo; items: MediaItem[]; threads?: ThreadSummary[]; scanning: boolean; progress?: Progress; warning?: string; ignored?: IgnoredSummary[]; reset?: boolean }) {
    return this.update(tabId, b.page, (s) => {
      if (b.reset || s.page.url !== b.page.url) { Object.assign(s, emptyScan(tabId, b.page)); }
      s.page = b.page;
      s.items = mergeMedia(s.items, b.items).items;
      if (b.threads) s.threads = b.threads;
      s.scanning = b.scanning;
      s.progress = b.progress;
      if (b.warning) s.warning = b.warning;
      if (b.ignored) s.ignored = b.ignored;
    });
  }

  async prune(keepTabId: number) {
    const all = await (globalThis as any).chrome.storage.session.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('scan:'));
    if (keys.length <= MAX_SCANS) return;
    const sorted = keys.map((k) => [k, all[k].updatedAt as number] as const).sort((a, b) => a[1] - b[1]);
    const drop = sorted.slice(0, keys.length - MAX_SCANS).map(([k]) => k).filter((k) => k !== scanKey(keepTabId));
    if (drop.length) await this.kv.remove(drop);
  }
}
