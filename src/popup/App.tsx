import { useEffect, useMemo, useState } from 'react';
import { detectPage, pageLabel } from '../content/page-detector';
import { send, sendToTab, type DownloadResponse } from '../shared/messaging';
import { countByType } from '../shared/media-filter';
import type { PageInfo } from '../shared/types';
import { useQueue, useScan, useSettings } from '../ui/hooks';

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [page, setPage] = useState<PageInfo | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind?: 'bad' | 'ok' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scan] = useScan(tabId);
  const { queue } = useQueue();
  useSettings();

  useEffect(() => {
    (globalThis as any).chrome.tabs.query({ active: true, currentWindow: true }).then(([t]: any[]) => {
      if (!t) return;
      setTabId(t.id);
      try { const u = new URL(t.url ?? ''); setPage(detectPage(u, t.title ?? '')); } catch { setPage(detectPage({ hostname: '', pathname: '', href: '' })); }
    });
  }, []);

  const counts = useMemo(() => countByType(scan?.items ?? []), [scan?.items]);
  const supported = page && page.kind !== 'unsupported';
  const q = useMemo(() => {
    const c = { pending: 0, active: 0, done: 0, failed: 0, skipped: 0 };
    for (const i of queue) {
      if (i.status === 'queued') c.pending++; else if (i.status === 'complete') c.done++; else if (i.status === 'failed') c.failed++;
      else if (i.status === 'skipped') c.skipped++; else if (i.status !== 'cancelled') c.active++;
    }
    return c;
  }, [queue]);
  const total = q.pending + q.active + q.done + q.failed;
  const recent = useMemo(() => [...queue].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6), [queue]);

  const doScan = async () => {
    if (tabId == null) return;
    setBusy(true);
    const r = await sendToTab(tabId, { type: 'SCAN_PAGE' });
    setBusy(false);
    setMsg(r ? { text: `Found ${r.count} media files.`, kind: 'ok' } : { text: 'Cannot reach this page. Reload the tab and try again.', kind: 'bad' });
  };
  const downloadAll = async () => {
    if (tabId == null) return;
    let r = await send<DownloadResponse>({ type: 'DOWNLOAD_REQUEST', tabId, scope: 'all' });
    if (r?.needsConfirm) { if (!confirm(`Download ${r.count} files?`)) return; r = await send<DownloadResponse>({ type: 'DOWNLOAD_REQUEST', tabId, scope: 'all', confirmed: true }); }
    setMsg(r?.ok ? { text: `Queued ${r.added} files${r.skipped?.length ? `, ${r.skipped.length} skipped` : ''}.`, kind: 'ok' } : { text: r?.error ?? 'Download service not responding.', kind: 'bad' });
  };
  const openManager = () => { void send({ type: 'OPEN_MANAGER', tabId: tabId ?? undefined }); window.close(); };

  return (
    <div className="popup">
      <div><h1>4loadable</h1><div className="muted">{page ? pageLabel(page) : 'Loading…'}</div></div>
      {!supported && page && <div className="notice">Open a 4chan board, catalog or thread to scan for media. You can still view the queue and history.</div>}
      <div className="stats" aria-label="Detected media">
        <div className="stat"><b>{scan?.items.length ?? 0}</b>Total</div>
        <div className="stat"><b style={{ color: 'var(--image)' }}>{counts.image}</b>Images</div>
        <div className="stat"><b style={{ color: 'var(--gif)' }}>{counts.gif}</b>GIFs</div>
        <div className="stat"><b style={{ color: 'var(--video)' }}>{counts.video}</b>Videos</div>
      </div>
      {scan?.scanning && scan.progress && <div><div className="muted">{scan.progress.label} {scan.progress.done}/{scan.progress.total}</div><div className="bar"><i style={{ width: `${(scan.progress.done / Math.max(1, scan.progress.total)) * 100}%` }} /></div></div>}
      {scan?.warning && <div className="notice">{scan.warning}</div>}
      {supported && scan && scan.items.length === 0 && !scan.scanning && <div className="notice">No media found on this page yet. Try Scan page after posts load.</div>}
      <div className="row">
        <button disabled={!supported || busy} onClick={doScan}>{busy ? 'Scanning…' : 'Scan page'}</button>
        <button className="primary" disabled={!supported || !scan?.items.length} onClick={downloadAll}>Download all</button>
        <button disabled={!supported} onClick={openManager}>Select media</button>
      </div>
      {msg && <div className={`notice ${msg.kind ?? ''}`} role="status">{msg.text}</div>}
      <div>
        <div className="row"><strong>Downloads</strong><span className="muted">{q.done} done · {q.active + q.pending} pending · {q.failed} failed{q.skipped ? ` · ${q.skipped} skipped` : ''}</span></div>
        <div className={`bar${q.active && !q.done ? ' indeterminate' : ''}`}><i style={{ width: `${total ? (q.done / total) * 100 : 0}%` }} /></div>
      </div>
      {recent.length > 0 && (
        <ul className="activity" aria-label="Recent activity">
          {recent.map((i) => <li key={i.id}><span className={`st ${i.status}`}>{i.status}</span><span className="name" title={i.error ?? i.path}>{i.path.split('/').pop()}</span></li>)}
        </ul>
      )}
      <div className="row"><a href="#" onClick={(e) => { e.preventDefault(); openManager(); }}>Open full media manager</a><span className="grow" />
        <a href="#" onClick={(e) => { e.preventDefault(); (globalThis as any).chrome.runtime.openOptionsPage(); }}>Settings</a></div>
    </div>
  );
}
