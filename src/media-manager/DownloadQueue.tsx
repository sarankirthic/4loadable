import { useMemo, useState } from 'react';
import { send } from '../shared/messaging';
import { formatBytes } from '../shared/media-filter';
import type { QueueItem, QueueStatus } from '../shared/types';
import { VirtualGrid } from '../ui/VirtualGrid';

type F = 'all' | 'active' | 'failed' | 'done';
const act = (action: any, id?: string) => send({ type: 'QUEUE_ACTION', action, id });
const isActive = (s: QueueStatus) => ['queued', 'starting', 'downloading', 'paused'].includes(s);

export function DownloadQueue({ queue, paused }: { queue: QueueItem[]; paused: boolean }) {
  const [f, setF] = useState<F>('all');
  const counts = useMemo(() => {
    const c = { queued: 0, active: 0, complete: 0, failed: 0, skipped: 0, cancelled: 0 };
    for (const i of queue) { if (i.status === 'downloading' || i.status === 'starting' || i.status === 'paused') c.active++; else c[i.status as 'queued']++; }
    return c;
  }, [queue]);
  const shown = useMemo(() => queue.filter((i) => f === 'all' || (f === 'active' && isActive(i.status)) || (f === 'failed' && i.status === 'failed') || (f === 'done' && (i.status === 'complete' || i.status === 'skipped'))), [queue, f]);
  return (
    <div className="main">
      <div className="toolbar">
        <div className="row">
          <span className="chip">Pending {counts.queued}</span><span className="chip">Active {counts.active}</span>
          <span className="chip">Completed {counts.complete}</span><span className="chip">Failed {counts.failed}</span>
          <span className="chip">Cancelled {counts.cancelled}</span>
          <span className="grow" />
          {paused ? <button className="primary" onClick={() => act('resumeAll')}>Resume queue</button> : <button onClick={() => act('pauseAll')}>Pause queue</button>}
          <button disabled={!counts.failed} onClick={() => act('retryFailed')}>Retry failed</button>
          <button className="danger" disabled={!counts.queued && !counts.active} onClick={() => confirm('Cancel all pending and active downloads?') && act('cancelAll')}>Cancel all</button>
          <button onClick={() => act('clearFinished')}>Clear finished</button>
        </div>
        <div className="row">{(['all', 'active', 'failed', 'done'] as F[]).map((k) => <button key={k} className={k === f ? 'primary' : ''} onClick={() => setF(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}
          {paused && <span className="notice">Queue is paused. Nothing new will start.</span>}</div>
      </div>
      <VirtualGrid items={shown} itemHeight={58} getKey={(i) => i.id} empty={<div className="empty">Nothing here yet. Downloads you start will show up in this list.</div>}
        render={(it) => {
          const pct = it.total && it.bytes != null ? Math.min(100, Math.round((it.bytes / it.total) * 100)) : it.status === 'complete' ? 100 : 0;
          return (
            <div className="qrow">
              <span className={`st ${it.status}`}>{it.status}{it.attempts ? ` (retry ${it.attempts})` : ''}</span>
              <div style={{ minWidth: 0 }}>
                <div className="nm" title={it.savedPath ?? it.path}>{it.path}</div>
                {it.error && <div style={{ color: 'var(--bad)' }} title={it.error}>{it.error}</div>}
                {!it.error && <div className="muted">&gt;&gt;{it.postNo}{it.size != null ? ` · ${formatBytes(it.size)}` : ''}</div>}
              </div>
              <div>
                <div className={`bar${it.status === 'starting' ? ' indeterminate' : ''}`}><i style={{ width: `${pct}%` }} /></div>
                <div className="muted">{it.bytes != null && it.status !== 'queued' ? `${formatBytes(it.bytes)}${it.total ? ` / ${formatBytes(it.total)}` : ''}` : ' '}</div>
              </div>
              <div className="row">
                {it.status === 'downloading' && <button onClick={() => act('pause', it.id)}>Pause</button>}
                {it.status === 'paused' && <button onClick={() => act('resume', it.id)}>Resume</button>}
                {isActive(it.status) && <button className="danger" onClick={() => act('cancel', it.id)}>Cancel</button>}
                {(it.status === 'failed' || it.status === 'cancelled') && <button onClick={() => act('retry', it.id)}>Retry</button>}
              </div>
            </div>
          );
        }} />
    </div>
  );
}
