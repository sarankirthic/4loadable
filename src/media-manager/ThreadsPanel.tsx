import { useMemo, useState } from 'react';
import { send } from '../shared/messaging';
import type { ScanState } from '../shared/types';
import { VirtualGrid } from '../ui/VirtualGrid';

/** Explicit, user-driven multi-thread scanning for board pages and catalogs. */
export function ThreadsPanel({ scan, tabId, notify }: { scan: ScanState; tabId: number; notify: (m: string) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const board = scan.page.board!;
  const threads = useMemo(() => scan.threads.filter((t) => !q || t.teaser.toLowerCase().includes(q.toLowerCase()) || t.id.includes(q)), [scan.threads, q]);
  const estimate = (n: number) => `${Math.ceil((n * 1.1) / 60)} min`;

  const scanThreads = (ids: string[]) => {
    if (!ids.length) return;
    if (!confirm(`Scan ${ids.length} thread${ids.length === 1 ? '' : 's'}? Requests are limited to one per second (about ${estimate(ids.length)}). You can cancel at any time.`)) return;
    void send({ type: 'SCAN_THREADS', tabId, board, threadIds: ids });
    notify(`Scanning ${ids.length} threads…`);
  };
  const loadAll = async () => {
    const r = await send<{ ok: boolean; count?: number; error?: string }>({ type: 'LIST_BOARD_THREADS', tabId, board });
    notify(r?.ok ? `Found ${r.count} threads on /${board}/` : r?.error ?? 'Could not list threads');
  };

  return (
    <div className="main">
      <div className="toolbar">
        <div className="row">
          <input type="text" placeholder="Filter threads" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter threads" />
          <button onClick={() => setSel(new Set(threads.map((t) => t.id)))}>Select all shown</button>
          <button onClick={() => setSel(new Set())}>None</button>
          <span className="grow" />
          <button onClick={loadAll}>List every thread on /{board}/</button>
          <button className="primary" disabled={!sel.size || scan.scanning} onClick={() => scanThreads([...sel])}>Scan {sel.size} selected</button>
          {scan.scanning && <button className="danger" onClick={() => send({ type: 'CANCEL_THREAD_SCAN', tabId })}>Cancel scan</button>}
        </div>
        <div className="muted">Threads on this page are fully scanned from 4chan's public API, one at a time. Nothing is crawled unless you start it.</div>
      </div>
      <VirtualGrid items={threads} itemHeight={44} getKey={(t) => t.id}
        empty={<div className="empty">No threads found on this page.</div>}
        render={(t) => (
          <label className={`listrow${sel.has(t.id) ? ' sel' : ''}`}>
            <input type="checkbox" checked={sel.has(t.id)} onChange={() => setSel((p) => { const n = new Set(p); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; })} />
            <span className="muted">{t.id}</span><span className="nm">{t.teaser}</span>
            {t.replies != null && <span className="muted">{t.replies} replies</span>}
          </label>
        )} />
    </div>
  );
}
