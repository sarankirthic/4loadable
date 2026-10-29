import { buildTargetPath, ensureUniquePaths, isSafeRelativePath } from '../shared/filename-utils';
import { parseMediaUrlForSite } from '../shared/media-url';
import type { DownloadOptions, DownloadSnapshot, HistoryRecord, MediaItem, NewQueueItem, QueueItem, Settings } from '../shared/types';
import type { DownloadsPort } from './queue-manager';

export interface PlanInput {
  items: MediaItem[];
  options: DownloadOptions;
  settings: Pick<Settings, 'fullResOnly'>;
  types?: { image: boolean; gif: boolean; video: boolean };
  history: Record<string, HistoryRecord>;
  /** Download ids whose file the browser reports as deleted from disk (so "skip" should not apply). */
  missingDownloadIds?: Set<number>;
  takenPaths?: Set<string>;
  batchId: string;
  date: string;
}
export interface Plan { entries: NewQueueItem[]; skipped: { id: string; reason: string }[] }

/** Turn media items into queue entries: validate, filter, skip known files, and compute unique safe paths. */
export function planDownloads(inp: PlanInput): Plan {
  const skipped: Plan['skipped'] = [];
  const picked: { item: MediaItem; path: string; dir: string }[] = []; // dir = manifest folder
  const seen = new Set<string>();
  let index = 0;
  for (const item of inp.items) {
    if (seen.has(item.id)) { skipped.push({ id: item.id, reason: 'Duplicate in selection' }); continue; }
    seen.add(item.id);
    const parsed = parseMediaUrlForSite(item.site, item.url);
    if (!parsed) { skipped.push({ id: item.id, reason: 'Unsupported or untrusted URL' }); continue; }
    if (inp.types && !inp.types[item.type]) { skipped.push({ id: item.id, reason: `${item.type} files excluded` }); continue; }
    if (inp.settings.fullResOnly && parsed.isThumb) { skipped.push({ id: item.id, reason: 'Thumbnail, not full resolution' }); continue; }
    const prior = inp.history[item.id];
    if (inp.options.duplicates === 'skip' && prior?.status === 'complete' && !(prior.downloadId != null && inp.missingDownloadIds?.has(prior.downloadId))) {
      skipped.push({ id: item.id, reason: 'Already downloaded' }); continue;
    }
    const safe = { ...item, url: parsed.url, ext: parsed.ext, type: parsed.type };
    const { threadDir, path } = buildTargetPath(safe, inp.options, { index: ++index, date: inp.date });
    picked.push({ item: safe, path, dir: threadDir });
  }
  const paths = ensureUniquePaths(picked.map((p) => p.path), inp.takenPaths);
  const entries: NewQueueItem[] = [];
  picked.forEach((p, i) => {
    if (!isSafeRelativePath(paths[i])) { skipped.push({ id: p.item.id, reason: 'Unsafe generated path' }); return; }
    entries.push({
      id: p.item.id, url: p.item.url, path: paths[i], type: p.item.type, site: p.item.site, board: p.item.board, threadId: p.item.threadId,
      postNo: p.item.postNo, originalName: p.item.originalName ? `${p.item.originalName}.${p.item.ext}` : `${p.item.tim}.${p.item.ext}`,
      ext: p.item.ext, md5: p.item.md5, size: p.item.size,
      conflict: inp.options.duplicates === 'prompt' ? 'prompt' : 'uniquify', saveAs: inp.options.saveAs,
      batchId: inp.batchId, manifestDir: inp.options.writeManifest && p.dir ? p.dir : undefined,
    });
  });
  return { entries, skipped };
}

export function historyFromItem(it: QueueItem, now = Date.now()): HistoryRecord {
  return {
    id: it.id, sourceUrl: it.url, originalFilename: it.originalName, mediaType: it.type, site: it.site, board: it.board,
    threadId: it.threadId, postNo: it.postNo, savedPath: it.savedPath ?? it.path, downloadId: it.downloadId,
    status: it.status === 'complete' ? 'complete' : it.status === 'skipped' ? 'skipped' : 'failed',
    error: it.error, timestamp: now,
  };
}

/** Build manifest.json content for every directory of a finished batch. Returns [dir, json] pairs. */
export function manifestsForBatch(items: QueueItem[], batchId: string): { dir: string; json: string; ids: string[] }[] {
  const group = items.filter((i) => i.batchId === batchId && i.manifestDir);
  if (!group.length || group.some((i) => !['complete', 'failed', 'skipped', 'cancelled'].includes(i.status))) return [];
  const byDir = new Map<string, QueueItem[]>();
  for (const i of group) { if (!i.manifestDone) (byDir.get(i.manifestDir!) ?? byDir.set(i.manifestDir!, []).get(i.manifestDir!)!).push(i); }
  return [...byDir].map(([dir, list]) => ({
    dir, ids: list.map((i) => i.id),
    json: JSON.stringify({
      generatedAt: new Date().toISOString(),
      files: list.map((i) => ({
        sourceUrl: i.url, originalFilename: i.originalName, mediaType: i.type, board: i.board, threadId: i.threadId,
        postNumber: i.postNo, savedPath: i.savedPath ?? i.path, status: i.status, ...(i.error ? { error: i.error } : {}),
        updatedAt: new Date(i.updatedAt).toISOString(),
      })),
    }, null, 2),
  }));
}

export function toDataUrl(text: string, mime = 'application/json'): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};charset=utf-8;base64,${btoa(bin)}`;
}

// ---- chrome.downloads adapter ----
const lastErr = () => (globalThis as any).chrome.runtime.lastError;

function promisify<T>(fn: (cb: (r: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((r) => { const e = lastErr(); e ? reject(new Error(e.message)) : resolve(r); }));
}

const toSnapshot = (d: any): DownloadSnapshot => ({
  id: d.id, state: d.state, paused: !!d.paused, error: d.error, bytesReceived: d.bytesReceived ?? 0,
  totalBytes: d.totalBytes ?? -1, filename: d.filename || undefined, exists: d.exists,
});

export function chromeDownloadsPort(): DownloadsPort {
  const dl = () => (globalThis as any).chrome.downloads;
  return {
    start: (o) => promisify<number>((cb) => dl().download({ url: o.url, filename: o.filename, conflictAction: o.conflictAction, saveAs: o.saveAs }, cb)).then((id) => {
      if (id == null) throw new Error('Download was not created');
      return id;
    }),
    pause: (id) => promisify<void>((cb) => dl().pause(id, cb)),
    resume: (id) => promisify<void>((cb) => dl().resume(id, cb)),
    cancel: (id) => promisify<void>((cb) => dl().cancel(id, cb)),
    query: async (ids) => {
      const out: DownloadSnapshot[] = [];
      for (const id of ids) {
        const r = await promisify<any[]>((cb) => dl().search({ id }, cb));
        if (r[0]) out.push(toSnapshot(r[0]));
      }
      return out;
    },
  };
}

/** Which of these download ids does the browser say no longer exist on disk? */
export async function findMissingDownloads(ids: number[]): Promise<Set<number>> {
  const missing = new Set<number>();
  const dl = (globalThis as any).chrome.downloads;
  for (const id of ids) {
    try { const r = await promisify<any[]>((cb) => dl.search({ id }, cb)); if (r[0] && r[0].exists === false) missing.add(id); } catch { /* ignore */ }
  }
  return missing;
}
