import { chromeKV, loadHistory, loadSettings, upsertHistory, normalizeSettings } from '../shared/storage';
import { selectionKey, type DownloadResponse, type Msg } from '../shared/messaging';
import { parseMediaUrl } from '../shared/media-detection';
import type { DownloadOptions, MediaItem } from '../shared/types';
import {
  chromeDownloadsPort, findMissingDownloads, historyFromItem, manifestsForBatch, planDownloads, toDataUrl,
} from './download-manager';
import { QueueManager } from './queue-manager';
import { ScanStore } from './scan-store';
import { listBoardThreads, realDeps, scanThreads, validBoard } from './thread-scanner';

const chromeApi = (globalThis as any).chrome;
const local = chromeKV('local');
const session = chromeKV('session');
const scans = new ScanStore(session);
const threadScans = new Map<number, AbortController>();

const queue = new QueueManager(
  {
    kv: local,
    downloads: chromeDownloadsPort(),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as number),
    onFinished: (it) => {
      void upsertHistory(local, [historyFromItem(it)]).catch((e) => console.warn('[history]', e));
      void writeManifestsIfDone(it.batchId);
    },
    onChange: () => ensurePolling(),
  },
  { maxConcurrent: 3, maxRetries: 2, retryBaseMs: 3000 },
);

const ready = (async () => {
  const s = await loadSettings(local);
  queue.cfg.maxConcurrent = s.maxConcurrent;
  queue.cfg.maxRetries = s.maxRetries;
  await queue.init();
  chromeApi.alarms.create('tick', { periodInMinutes: 0.5 });
  ensurePolling();
})();

// ---- progress polling keeps the worker alive while downloads run ----
let pollTimer: ReturnType<typeof setInterval> | null = null;
function ensurePolling() {
  if (pollTimer || queue.countActive() === 0) return;
  pollTimer = setInterval(async () => {
    const stillActive = await queue.poll().catch(() => false);
    if (!stillActive && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }, 1000);
}

chromeApi.downloads.onChanged.addListener((delta: { id: number }) => { void ready.then(() => queue.onDownloadChanged(delta.id)); });
chromeApi.alarms.onAlarm.addListener(() => { void ready.then(async () => { await queue.reconcile(); ensurePolling(); }); });
chromeApi.storage.onChanged.addListener((changes: any, area: string) => {
  if (area === 'local' && changes.settings) {
    const s = normalizeSettings(changes.settings.newValue);
    queue.cfg.maxConcurrent = s.maxConcurrent;
    queue.cfg.maxRetries = s.maxRetries;
    void queue.pump();
  }
});

async function writeManifestsIfDone(batchId: string) {
  const items = [...queue.items.values()];
  for (const m of manifestsForBatch(items, batchId)) {
    for (const id of m.ids) { const it = queue.items.get(id); if (it) it.manifestDone = true; }
    try {
      await new Promise<void>((resolve, reject) =>
        chromeApi.downloads.download({ url: toDataUrl(m.json), filename: `${m.dir}/manifest.json`, conflictAction: 'uniquify', saveAs: false },
          () => (chromeApi.runtime.lastError ? reject(new Error(chromeApi.runtime.lastError.message)) : resolve())));
    } catch (e) { console.warn('[manifest]', e); }
  }
  await queue.flush();
}

// ---- helpers ----
async function getSelection(tabId: number): Promise<string[]> {
  return ((await session.get(selectionKey(tabId)))[selectionKey(tabId)] as string[]) ?? [];
}
async function setSelection(tabId: number, ids: string[]) { await session.set({ [selectionKey(tabId)]: ids }); }

function setBadge(tabId: number, n: number) {
  try {
    chromeApi.action.setBadgeText({ tabId, text: n ? (n > 999 ? '999+' : String(n)) : '' });
    chromeApi.action.setBadgeBackgroundColor({ tabId, color: '#5f819d' });
  } catch { /* tab may be gone */ }
}

async function handleDownloadRequest(m: Extract<Msg, { type: 'DOWNLOAD_REQUEST' }>, senderTabId?: number): Promise<DownloadResponse> {
  await ready;
  if (m.tabId === -1) { if (senderTabId == null) return { ok: false, error: 'Unknown tab.' }; m = { ...m, tabId: senderTabId }; }
  const settings = await loadSettings(local);
  const scan = await scans.get(m.tabId);
  if (!scan || !scan.items.length) return { ok: false, error: 'No media found. Scan the page first.' };

  let items: MediaItem[];
  if (m.scope === 'all') items = scan.items;
  else {
    const ids = new Set(m.scope === 'ids' ? m.ids ?? [] : await getSelection(m.tabId));
    items = scan.items.filter((i) => ids.has(i.id));
  }
  const types = m.scope === 'all' ? m.types ?? settings.types : m.types;
  const options: DownloadOptions = { ...settings, ...(m.options ?? {}) };
  const history = await loadHistory(local);
  const past = Object.values(history).filter((h) => h.status === 'complete' && h.downloadId != null).map((h) => h.downloadId!);
  const missing = options.duplicates === 'skip' ? await findMissingDownloads(past.slice(-2000)) : new Set<number>();
  const taken = new Set([...queue.items.values()].filter((i) => !['cancelled', 'failed'].includes(i.status)).map((i) => i.path));
  const plan = planDownloads({
    items, options, settings, types, history, missingDownloadIds: missing, takenPaths: taken,
    batchId: `b${Date.now().toString(36)}`, date: new Date().toISOString().slice(0, 10),
  });

  if (!plan.entries.length) {
    return { ok: false, error: items.length ? 'Nothing to download: every file was skipped.' : 'No media selected.', skipped: plan.skipped, count: 0 };
  }
  if (!m.confirmed && settings.confirmBulk && plan.entries.length >= settings.confirmThreshold) {
    return { ok: true, needsConfirm: true, count: plan.entries.length, skipped: plan.skipped };
  }
  const { added, duplicates } = queue.enqueue(plan.entries);
  ensurePolling();
  return { ok: true, added, duplicates, skipped: plan.skipped, count: plan.entries.length };
}

async function runThreadScan(tabId: number, board: string, ids: string[]) {
  threadScans.get(tabId)?.abort();
  const ac = new AbortController();
  threadScans.set(tabId, ac);
  const page = (await scans.get(tabId))?.page ?? { kind: 'board' as const, site: 'fourchan', board, url: '', title: board };
  await scans.update(tabId, page, (s) => { s.scanning = true; s.progress = { done: 0, total: ids.length, label: 'Starting' }; });
  await scanThreads(board, ids, realDeps, {
    onItems: async (items, done, total, label) => {
      const s = await scans.applyBatch(tabId, { page, items, scanning: done < total, progress: { done, total, label } });
      setBadge(tabId, s.items.length);
    },
    onError: (msg) => { void scans.update(tabId, page, (s) => { s.errors = [...s.errors.slice(-49), msg]; }); },
  }, ac.signal);
  await scans.update(tabId, page, (s) => { s.scanning = false; s.progress = undefined; });
  if (threadScans.get(tabId) === ac) threadScans.delete(tabId);
}

async function checkLinks(tabId: number, ids: string[]) {
  const scan = await scans.get(tabId);
  if (!scan) return;
  const wanted = new Set(ids.slice(0, 2000));
  const targets = scan.items.filter((i) => wanted.has(i.id) && parseMediaUrl(i.url));
  const result = new Map<string, 'ok' | 'broken'>();
  let done = 0;
  const worker = async () => {
    while (targets.length) {
      const it = targets.shift()!;
      try { const r = await fetch(it.url, { method: 'HEAD', credentials: 'omit' }); result.set(it.id, r.ok ? 'ok' : 'broken'); }
      catch { /* network error is not proof the file is gone */ }
      if (++done % 25 === 0) await scans.update(tabId, scan.page, (s) => { s.progress = { done, total: wanted.size, label: 'Checking links' }; s.scanning = true; });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  await scans.update(tabId, scan.page, (s) => {
    s.items = s.items.map((i) => (result.has(i.id) ? { ...i, availability: result.get(i.id) } : i));
    s.scanning = false; s.progress = undefined;
  });
}

// ---- message router ----
chromeApi.runtime.onMessage.addListener((msg: Msg, sender: any, sendResponse: (r: unknown) => void) => {
  (async () => {
    await ready;
    switch (msg.type) {
      case 'SCAN_BATCH': {
        const tabId = sender.tab?.id;
        if (tabId == null) return { ok: false };
        const s = await scans.applyBatch(tabId, msg);
        setBadge(tabId, s.items.length);
        void scans.prune(tabId);
        return { ok: true };
      }
      case 'DOWNLOAD_REQUEST': return handleDownloadRequest(msg, sender.tab?.id);
      case 'QUEUE_ACTION': {
        const id = msg.id ?? '';
        if (msg.action === 'pause') await queue.pauseItem(id);
        else if (msg.action === 'resume') await queue.resumeItem(id);
        else if (msg.action === 'cancel') await queue.cancelItem(id);
        else if (msg.action === 'retry') queue.retryItem(id);
        else if (msg.action === 'pauseAll') await queue.pauseAll();
        else if (msg.action === 'resumeAll') await queue.resumeAll();
        else if (msg.action === 'cancelAll') await queue.cancelAll();
        else if (msg.action === 'retryFailed') queue.retryFailed();
        else if (msg.action === 'clearFinished') queue.clearFinished();
        await queue.flush();
        ensurePolling();
        return { ok: true };
      }
      case 'SCAN_THREADS': {
        if (!validBoard(msg.board)) return { ok: false, error: 'Invalid board.' };
        void runThreadScan(msg.tabId, msg.board, msg.threadIds);
        return { ok: true };
      }
      case 'CANCEL_THREAD_SCAN': {
        threadScans.get(msg.tabId)?.abort();
        threadScans.delete(msg.tabId);
        const cur = await scans.get(msg.tabId);
        if (cur) await scans.update(msg.tabId, cur.page, (s) => { s.scanning = false; s.progress = undefined; });
        return { ok: true };
      }
      case 'LIST_BOARD_THREADS': {
        try {
          const threads = await listBoardThreads(msg.board, realDeps, new AbortController().signal);
          const cur = await scans.get(msg.tabId);
          if (cur) await scans.update(msg.tabId, cur.page, (s) => {
            const have = new Map(s.threads.map((t) => [t.id, t]));
            s.threads = threads.map((t) => ({ ...have.get(t.id), ...t, teaser: have.get(t.id)?.teaser || t.teaser }));
          });
          return { ok: true, count: threads.length };
        } catch (e) { return { ok: false, error: (e as Error).message }; }
      }
      case 'CHECK_LINKS': void checkLinks(msg.tabId, msg.ids); return { ok: true };
      case 'SELECT': {
        let tabId = msg.tabId ?? sender.tab?.id;
        if (tabId == null) return { ok: false };
        const cur = msg.mode === 'add' ? await getSelection(tabId) : [];
        await setSelection(tabId, [...new Set([...cur, ...msg.ids])]);
        return { ok: true, count: (await getSelection(tabId)).length };
      }
      case 'OPEN_MANAGER': {
        const tabId = msg.tabId ?? sender.tab?.id;
        await chromeApi.tabs.create({ url: chromeApi.runtime.getURL(`manager.html${tabId != null ? `?tab=${tabId}` : ''}`) });
        return { ok: true };
      }
      default: return { ok: false };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true;
});

chromeApi.tabs.onRemoved.addListener((tabId: number) => { threadScans.get(tabId)?.abort(); threadScans.delete(tabId); });
chromeApi.runtime.onInstalled.addListener(() => { /* defaults are applied lazily by loadSettings */ });

