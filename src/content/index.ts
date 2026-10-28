import { chromeKV, loadSettings } from '../shared/storage';
import { send, type DownloadResponse, type TabMsg } from '../shared/messaging';
import type { IgnoredSummary, MediaItem, PageInfo, Settings } from '../shared/types';
import { createToolbar } from './in-page-toolbar';
import { scanDocument, scanThreadList } from './media-scanner';
import { detectPage } from './page-detector';

const chromeApi = (globalThis as any).chrome;
const page: PageInfo = detectPage(location, document.title);

if (page.kind !== 'unsupported') void main();

async function main() {
  let settings: Settings = await loadSettings(chromeKV('local'));
  const known = new Set<string>();
  const elements = new Map<string, Element>();
  let order = 0;
  let cancelToken = 0;
  let toolbar: ReturnType<typeof createToolbar> | null = null;
  let queueTail: Promise<unknown> = Promise.resolve();
  const ignoredLinks = new Map<string, { reason: IgnoredSummary['reason']; detail: string }>();
  const ignoredSummary = (): IgnoredSummary[] => {
    const g = new Map<string, IgnoredSummary>();
    for (const { reason, detail } of ignoredLinks.values()) {
      const k = reason + '|' + detail; const e = g.get(k);
      e ? e.count++ : g.set(k, { reason, detail, count: 1 });
    }
    return [...g.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  };

  const ctx = () => ({ board: page.board!, defaultThreadId: page.threadId ?? '', includeQuoted: settings.includeQuoted, baseUrl: location.href });
  const threads = () => (page.kind === 'thread' ? [] : scanThreadList(document));

  /** Scans run one at a time so progress and ordering stay coherent. */
  function scan(root: ParentNode, opts: { announce: boolean; reset?: boolean }) {
    const run = async () => {
      const myToken = cancelToken;
      let sent = false;
      const pending: MediaItem[] = [];
      let lastProgress = 0;
      const flush = async (scanning: boolean, progress?: { done: number; total: number }) => {
        const items = pending.splice(0);
        await send({
          type: 'SCAN_BATCH', page, items, threads: threads(), scanning,
          progress: progress ? { ...progress, label: 'Scanning posts' } : undefined, reset: opts.reset && !sent,
        });
        sent = true;
      };
      const res = await scanDocument(root, ctx(), {
        known, elements, startOrder: order, onIgnored: (href, reason, detail) => { if (ignoredLinks.size < 5000) ignoredLinks.set(href, { reason, detail }); },
        shouldCancel: () => myToken !== cancelToken,
        onItems: (b) => { pending.push(...b); order += b.length; toolbar?.setCount(known.size); },
        onProgress: (done, total) => {
          if (opts.announce && Date.now() - lastProgress > 250 && done < total) { lastProgress = Date.now(); void flush(true, { done, total }); }
        },
      });
      await send({
        type: 'SCAN_BATCH', page, items: pending.splice(0), threads: threads(), scanning: false, warning: res.warning, ignored: ignoredSummary(),
        reset: opts.reset && !sent,
      });
      toolbar?.setCount(known.size);
      return res;
    };
    const p = queueTail.then(run, run);
    queueTail = p.catch(() => {});
    return p;
  }

  async function visibleIds(): Promise<string[]> {
    const out: string[] = [];
    for (const [id, el] of elements) {
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.width > 0) out.push(id);
    }
    return out;
  }

  function mountToolbar() {
    if (toolbar || !settings.inPageToolbar) return;
    toolbar = createToolbar({
      scan: () => { void scan(document, { announce: true }).then(() => toolbar?.flash(`${known.size} files`)); },
      selectVisible: async () => {
        const ids = await visibleIds();
        await send({ type: 'SELECT', mode: 'add', ids });
        toolbar?.flash(`Selected ${ids.length} visible`);
      },
      downloadSelected: async () => {
        let r = await send<DownloadResponse>({ type: 'DOWNLOAD_REQUEST', tabId: -1, scope: 'selected' });
        if (r?.needsConfirm && confirm(`Download ${r.count} files?`)) r = await send<DownloadResponse>({ type: 'DOWNLOAD_REQUEST', tabId: -1, scope: 'selected', confirmed: true });
        else if (r?.needsConfirm) return;
        toolbar?.flash(r?.ok ? `Queued ${r.added ?? 0} files` : r?.error ?? 'Could not start download');
      },
      openManager: () => { void send({ type: 'OPEN_MANAGER' }); },
    });
    toolbar.setCount(known.size);
  }
  function unmountToolbar() { toolbar?.destroy(); toolbar = null; }

  // Initial scan + dynamic content.
  await scan(document, { announce: true, reset: true });
  mountToolbar();

  const added = new Set<Element>();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver((muts) => {
    for (const m of muts) for (const n of Array.from(m.addedNodes)) {
      if (n instanceof Element && n.id !== 'cmd-toolbar-host') added.add(n);
    }
    if (!added.size) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const roots = [...added]; added.clear();
      if (roots.length > 20) void scan(document, { announce: false });
      else for (const r of roots) if (r.isConnected) void scan(r, { announce: false });
    }, 600);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  chromeApi.runtime.onMessage.addListener((msg: TabMsg, _s: unknown, respond: (r: unknown) => void) => {
    if (msg.type === 'SCAN_PAGE') { void scan(document, { announce: true }).then(() => respond({ ok: true, count: known.size })); return true; }
    if (msg.type === 'CANCEL_SCAN') { cancelToken++; respond({ ok: true }); return false; }
    if (msg.type === 'GET_VISIBLE_IDS') { void visibleIds().then(respond); return true; }
    return false;
  });
  chromeApi.storage.onChanged.addListener((c: any, area: string) => {
    if (area !== 'local' || !c.settings) return;
    void loadSettings(chromeKV('local')).then((s) => { settings = s; s.inPageToolbar ? mountToolbar() : unmountToolbar(); });
  });
}
