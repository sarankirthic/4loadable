import { useMemo } from 'react';
import { toCsv, toJson } from '../shared/manifest-export';
import type { HistoryRecord } from '../shared/types';
import { VirtualGrid } from '../ui/VirtualGrid';

function saveText(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function HistoryPanel({ history }: { history: Record<string, HistoryRecord> }) {
  const rows = useMemo(() => Object.values(history).sort((a, b) => b.timestamp - a.timestamp), [history]);
  const stamp = new Date().toISOString().slice(0, 10);
  const clear = () => confirm('Clear the recorded download history? Downloaded files are not deleted.') && (globalThis as any).chrome.storage.local.remove('history');
  return (
    <div className="main">
      <div className="toolbar"><div className="row">
        <span>{rows.length} recorded file{rows.length === 1 ? '' : 's'}</span><span className="grow" />
        <button disabled={!rows.length} onClick={() => saveText(`4chan-manifest-${stamp}.json`, toJson(rows), 'application/json')}>Export JSON</button>
        <button disabled={!rows.length} onClick={() => saveText(`4chan-manifest-${stamp}.csv`, toCsv(rows), 'text/csv')}>Export CSV</button>
        <button className="danger" disabled={!rows.length} onClick={clear}>Clear history</button>
      </div></div>
      <VirtualGrid items={rows} itemHeight={44} getKey={(r) => r.id} empty={<div className="empty">No downloads recorded yet.</div>}
        render={(r) => (
          <div className="listrow" style={{ cursor: 'default' }}>
            <span className={`badge ${r.mediaType}`}>{r.mediaType === 'image' ? 'IMG' : r.mediaType === 'gif' ? 'GIF' : 'VID'}</span>
            <span className="nm" title={r.savedPath}>{r.savedPath}</span>
            <span className="muted">/{r.board}/ &gt;&gt;{r.postNo}</span>
            <span className={`st ${r.status === 'complete' ? 'complete' : 'failed'}`} title={r.error}>{r.status}</span>
            <span className="muted">{new Date(r.timestamp).toLocaleString()}</span>
          </div>
        )} />
    </div>
  );
}
