import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pageLabel } from '../content/page-detector';
import { send, sendToTab, type DownloadResponse } from '../shared/messaging';
import {
  countByType, DEFAULT_FILTER, filterAndSort, formatBytes, invertSelection, selectAll, selectionSummary, selectRange, selectType, type FilterState,
} from '../shared/media-filter';
import type { DownloadOptions, MediaType, Settings } from '../shared/types';
import { useHistory, useQueue, useScan, useSelection, useSettings, useStorage, useToast } from '../ui/hooks';
import { DownloadDialog } from './DownloadDialog';
import { DownloadQueue } from './DownloadQueue';
import { HistoryPanel } from './HistoryPanel';
import { MediaFilters } from './MediaFilters';
import { MediaGrid } from './MediaGrid';
import { PreviewModal } from './PreviewModal';
import { ThreadsPanel } from './ThreadsPanel';

type Tab = 'media' | 'threads' | 'queue' | 'history';
const IGNORED_WHY = { type: 'unsupported file type', host: 'host not on the allowlist', path: 'unrecognized URL form', layout: 'unexpected page layout' } as const;
const tabParam = Number(new URLSearchParams(location.search).get('tab'));
const TAB_ID = Number.isFinite(tabParam) && tabParam > 0 ? tabParam : null;

export function MediaManager() {
  const [settings, updateSettings] = useSettings();
  const [scan] = useScan(TAB_ID);
  const [selected, setSelected] = useSelection(TAB_ID);
  const { queue, paused } = useQueue();
  const [history] = useHistory();
  const [tab, setTab] = useState<Tab>('media');
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER);
  const [preview, setPreview] = useState<number | null>(null);
  const [dialog, setDialog] = useState<null | 'selected' | 'all'>(null);
  const [toast, notify] = useToast();
  const anchor = useRef(0);

  const items = scan?.items ?? [];
  const shown = useMemo(() => filterAndSort(items, filter), [items, filter]);
  const counts = useMemo(() => countByType(items), [items]);
  const sum = useMemo(() => selectionSummary(items, selected), [items, selected]);
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected]);
  const multi = scan?.page.kind === 'board' || scan?.page.kind === 'catalog';

  // Optionally restore the last selection for this thread/board.
  const sourceKey = scan ? `lastSelection:${scan.page.board}/${scan.page.threadId ?? scan.page.kind}` : null;
  const restored = useRef<string | null>(null);
  const [remembered] = useStorage<string[]>('local', settings.rememberSelection ? sourceKey : null, []);
  useEffect(() => {
    if (!settings.rememberSelection || !sourceKey || restored.current === sourceKey || !items.length) return;
    restored.current = sourceKey;
    if (!selected.size && remembered.length) setSelected(new Set(remembered.filter((id) => items.some((i) => i.id === id))));
  }, [settings.rememberSelection, sourceKey, items, remembered, selected.size, setSelected]);
  useEffect(() => {
    if (settings.rememberSelection && sourceKey && restored.current === sourceKey) void (globalThis as any).chrome.storage.local.set({ [sourceKey]: [...selected] });
  }, [selected, settings.rememberSelection, sourceKey]);

  const onToggle = useCallback((index: number, shift: boolean) => {
    const it = shown[index];
    if (!it) return;
    const on = !selected.has(it.id);
    if (shift) setSelected(selectRange(shown, anchor.current, index, selected, on));
    else { const n = new Set(selected); on ? n.add(it.id) : n.delete(it.id); setSelected(n); }
    anchor.current = index;
  }, [shown, selected, setSelected]);

  const start = async (scope: 'selected' | 'all', options: DownloadOptions, types: Settings['types'], confirmed = false) => {
    if (TAB_ID == null) return;
    const r = await send<DownloadResponse>({
      type: 'DOWNLOAD_REQUEST', tabId: TAB_ID, scope: scope === 'all' ? 'all' : 'ids',
      ids: scope === 'selected' ? [...selected] : undefined, options, types: scope === 'all' ? types : undefined, confirmed: true,
    });
    void confirmed;
    setDialog(null);
    if (!r?.ok) { notify(r?.error ?? 'The background service did not respond. Reload the extension.'); return; }
    const skipped = r.skipped?.length ?? 0;
    notify(`Queued ${r.added} file${r.added === 1 ? '' : 's'}${r.duplicates ? `, ${r.duplicates} already in the queue` : ''}${skipped ? `, ${skipped} skipped` : ''}.`);
    setTab('queue');
  };

  const rescan = async () => {
    if (TAB_ID == null) return;
    const r = await sendToTab<{ ok: boolean }>(TAB_ID, { type: 'SCAN_PAGE' });
    if (!r) notify('Could not reach the page. Reload the 4chan tab, then try again.');
  };

  return (
    <div className="app">
      <header className="top">
        <img src="logo.png" alt="" className="logo" width={92} height={24} />
        <h1>4loadable Manager</h1>
        <span className="muted">{scan ? pageLabel(scan.page) : 'No page selected'}</span>
        <span className="grow" />
        <button onClick={() => updateSettings({ view: settings.view === 'grid' ? 'list' : 'grid' })}>{settings.view === 'grid' ? 'List view' : 'Grid view'}</button>
        <button onClick={() => updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}>{settings.theme === 'dark' ? 'Light theme' : 'Dark theme'}</button>
        <button onClick={() => (globalThis as any).chrome.runtime.openOptionsPage()}>Settings</button>
      </header>
      <nav className="tabs" role="tablist">
        {([['media', `Media (${items.length})`], ...(multi ? [['threads', `Threads (${scan?.threads.length ?? 0})`]] : []), ['queue', `Queue (${queue.filter((q) => ['queued', 'starting', 'downloading', 'paused'].includes(q.status)).length})`], ['history', 'History']] as [Tab, string][])
          .map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}
      </nav>

      {scan?.scanning && scan.progress && (
        <div className="toolbar"><div className="row"><span>{scan.progress.label}: {scan.progress.done} / {scan.progress.total}</span>
          <div className="bar grow"><i style={{ width: `${scan.progress.total ? (scan.progress.done / scan.progress.total) * 100 : 0}%` }} /></div>
          <button onClick={() => { void sendToTab(TAB_ID!, { type: 'CANCEL_SCAN' }); void send({ type: 'CANCEL_THREAD_SCAN', tabId: TAB_ID! }); }}>Cancel</button></div></div>
      )}
      {scan?.ignored && scan.ignored.length > 0 && (
        <div className="toolbar"><div className="notice" role="note">
          <strong>{scan.ignored.reduce((n, g) => n + g.count, 0)} file link(s) on this page were not added:</strong>{' '}
          {scan.ignored.map((g) => `${g.count} × ${g.detail} (${IGNORED_WHY[g.reason]})`).join('; ')}.
          <div className="muted">Unsupported types (for example .swf or .pdf) are skipped by design. If something else is missing, note the board and file type and update the rules in src/shared/media-detection.ts.</div>
        </div></div>
      )}
      {scan?.warning && <div className="toolbar"><div className="notice">{scan.warning}</div></div>}
      {scan && scan.errors.length > 0 && <div className="toolbar"><div className="notice bad">{scan.errors.slice(-3).join(' ')}</div></div>}

      {tab === 'media' && (
        <div className="main">
          {TAB_ID == null || !scan ? (
            <div className="empty">Open a 4chan board or thread, click the extension icon, then choose "Select media".</div>
          ) : (
            <>
              <MediaFilters filter={filter} setFilter={setFilter} counts={counts}
                onSelectAll={() => setSelected(selectAll(shown))} onSelectNone={() => setSelected(new Set())}
                onInvert={() => setSelected(invertSelection(shown, selected))} onSelectType={(t: MediaType) => setSelected(selectType(shown, t))} />
              <div className="toolbar"><div className="row">
                <button onClick={rescan}>Rescan page</button>
                {scan.page.kind === 'thread' && scan.page.board && scan.page.threadId && (
                  <button disabled={scan.scanning} title="Reads this thread's file list from 4chan's public API (one request) and adds anything the page scan missed"
                    onClick={() => { void send({ type: 'SCAN_THREADS', tabId: TAB_ID, board: scan.page.board!, threadIds: [scan.page.threadId!] }); notify('Checking the thread against 4chan’s API…'); }}>
                    Add missing files from 4chan API</button>
                )}
                <button disabled={!shown.length} onClick={() => send({ type: 'CHECK_LINKS', tabId: TAB_ID, ids: shown.slice(0, 2000).map((i) => i.id) })}
                  title="Sends one lightweight HEAD request per file to find deleted media (up to 2,000)">Check for deleted files</button>
                <span className="muted">Showing {shown.length} of {items.length}</span>
              </div></div>
              <MediaGrid items={shown} selected={selected} view={settings.view} onToggle={onToggle} onPreview={setPreview} />
              <div className="actionbar">
                <strong>{sum.count} selected</strong>
                <span className="muted">{sum.knownSizes ? `about ${formatBytes(sum.bytes)}${sum.knownSizes < sum.count ? ' (some sizes unknown)' : ''}` : sum.count ? 'size unknown' : ''}</span>
                <span className="grow" />
                <button disabled={!sum.count} onClick={() => setDialog('selected')} className="primary">Download selected</button>
                <button disabled={!items.length} onClick={() => setDialog('all')}>Download all ({items.length})</button>
              </div>
            </>
          )}
        </div>
      )}
      {tab === 'threads' && scan && TAB_ID != null && <ThreadsPanel scan={scan} tabId={TAB_ID} notify={notify} />}
      {tab === 'queue' && <DownloadQueue queue={queue} paused={paused} />}
      {tab === 'history' && <HistoryPanel history={history} />}

      {preview != null && <PreviewModal items={shown} index={preview} selected={selected} onClose={() => setPreview(null)} onNav={setPreview}
        onToggle={(id) => { const n = new Set(selected); n.has(id) ? n.delete(id) : n.add(id); setSelected(n); }} />}
      {dialog && <DownloadDialog title={dialog === 'all' ? 'Download everything found' : 'Download selected'} items={dialog === 'all' ? items : selectedItems}
        settings={settings} showTypes={dialog === 'all'} onCancel={() => setDialog(null)} onStart={(o, t) => start(dialog, o, t)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
