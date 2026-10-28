import type { HistoryRecord, Settings } from './types';

export interface KV {
  get(keys: string | string[]): Promise<Record<string, any>>;
  set(items: Record<string, any>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class StorageQuotaError extends Error {
  constructor() { super('Storage quota exceeded. Clear old history or export it first.'); }
}

export function chromeKV(area: 'local' | 'session' = 'local'): KV {
  const a = (globalThis as any).chrome.storage[area];
  return {
    get: (k) => a.get(k),
    set: async (i) => {
      try { await a.set(i); } catch (e) {
        if (/quota/i.test(String((e as Error)?.message))) throw new StorageQuotaError();
        throw e;
      }
    },
    remove: (k) => a.remove(k),
  };
}

export class MemoryKV implements KV {
  data: Record<string, any> = {};
  quotaBytes = Infinity;
  async get(keys: string | string[]) {
    const ks = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, any> = {};
    for (const k of ks) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, any>) {
    const next = { ...this.data, ...structuredClone(items) };
    if (JSON.stringify(next).length > this.quotaBytes) throw new StorageQuotaError();
    this.data = next;
  }
  async remove(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) delete this.data[k]; }
}

export const DEFAULT_SETTINGS: Settings = {
  rootFolder: '4lodable', subfolder: '', organize: 'board-thread-type',
  filenameMode: 'original', filenameTemplate: '{post}_{original}', duplicates: 'rename',
  saveAs: false, writeManifest: true,
  types: { image: true, gif: true, video: true },
  maxConcurrent: 3, maxRetries: 2, view: 'grid', theme: 'dark',
  confirmBulk: true, confirmThreshold: 50, rememberSelection: false,
  includeQuoted: false, fullResOnly: true, inPageToolbar: true,
};

const clamp = (n: unknown, lo: number, hi: number, d: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};
const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string, max = 200) => (typeof v === 'string' ? v.slice(0, max) : d);

/** Validate untrusted/partial settings against defaults. */
export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const r: any = raw ?? {};
  const d = DEFAULT_SETTINGS;
  return {
    rootFolder: str(r.rootFolder, d.rootFolder), subfolder: str(r.subfolder, d.subfolder),
    organize: oneOf(r.organize, ['board-thread-type', 'board-thread', 'flat'], d.organize),
    filenameMode: oneOf(r.filenameMode, ['original', 'server', 'template'], d.filenameMode),
    filenameTemplate: str(r.filenameTemplate, d.filenameTemplate),
    duplicates: oneOf(r.duplicates, ['rename', 'skip', 'prompt'], d.duplicates),
    saveAs: bool(r.saveAs, d.saveAs), writeManifest: bool(r.writeManifest, d.writeManifest),
    types: { image: bool(r.types?.image, true), gif: bool(r.types?.gif, true), video: bool(r.types?.video, true) },
    maxConcurrent: clamp(r.maxConcurrent, 1, 8, d.maxConcurrent), maxRetries: clamp(r.maxRetries, 0, 10, d.maxRetries),
    view: oneOf(r.view, ['grid', 'list'], d.view), theme: oneOf(r.theme, ['dark', 'light'], d.theme),
    confirmBulk: bool(r.confirmBulk, d.confirmBulk), confirmThreshold: clamp(r.confirmThreshold, 1, 100000, d.confirmThreshold),
    rememberSelection: bool(r.rememberSelection, d.rememberSelection), includeQuoted: bool(r.includeQuoted, d.includeQuoted),
    fullResOnly: bool(r.fullResOnly, d.fullResOnly), inPageToolbar: bool(r.inPageToolbar, d.inPageToolbar),
  };
}

export async function loadSettings(kv: KV): Promise<Settings> {
  return normalizeSettings((await kv.get('settings')).settings);
}
export async function saveSettings(kv: KV, s: Settings): Promise<void> {
  await kv.set({ settings: normalizeSettings(s) });
}

// ---- Download history (the data behind manifest export) ----
export const HISTORY_CAP = 20000;

export async function loadHistory(kv: KV): Promise<Record<string, HistoryRecord>> {
  return ((await kv.get('history')).history ?? {}) as Record<string, HistoryRecord>;
}

export function pruneHistory(h: Record<string, HistoryRecord>, cap = HISTORY_CAP): Record<string, HistoryRecord> {
  const entries = Object.entries(h);
  if (entries.length <= cap) return h;
  entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
  return Object.fromEntries(entries.slice(0, cap));
}

/** Upsert records. On quota errors, drop the oldest 20% and retry once before surfacing the error. */
const historyLocks = new WeakMap<KV, Promise<unknown>>();

/** Writes are serialized per store: concurrent read-modify-write cycles would otherwise lose records. */
export function upsertHistory(kv: KV, records: HistoryRecord[], cap = HISTORY_CAP): Promise<void> {
  const prev = historyLocks.get(kv) ?? Promise.resolve();
  const run = () => upsertHistoryUnsafe(kv, records, cap);
  const next = prev.then(run, run);
  historyLocks.set(kv, next.catch(() => {}));
  return next;
}

async function upsertHistoryUnsafe(kv: KV, records: HistoryRecord[], cap: number): Promise<void> {
  let h = await loadHistory(kv);
  for (const r of records) h[r.id] = r;
  h = pruneHistory(h, cap);
  try { await kv.set({ history: h }); } catch (e) {
    if (!(e instanceof StorageQuotaError)) throw e;
    h = pruneHistory(h, Math.floor(Object.keys(h).length * 0.8));
    await kv.set({ history: h });
  }
}
