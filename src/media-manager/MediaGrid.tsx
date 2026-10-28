import { useState } from 'react';
import { formatBytes } from '../shared/media-filter';
import type { MediaItem } from '../shared/types';
import { VirtualGrid } from '../ui/VirtualGrid';

const LABEL = { image: 'IMG', gif: 'GIF', video: 'VID' } as const;

interface Props {
  items: MediaItem[];
  selected: Set<string>;
  view: 'grid' | 'list';
  onToggle: (index: number, shift: boolean) => void;
  onPreview: (index: number) => void;
}

function Thumb({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);
  if (!item.thumbUrl || failed) return <span className="muted">{item.ext.toUpperCase()}</span>;
  return <img src={item.thumbUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

const meta = (i: MediaItem) => [i.size != null ? formatBytes(i.size) : null, i.width && i.height ? `${i.width}×${i.height}` : null].filter(Boolean).join(' · ');

export function MediaGrid({ items, selected, view, onToggle, onPreview }: Props) {
  const empty = <div className="empty">No media to show. Scan the page, or loosen the filters.</div>;
  if (view === 'list') {
    return (
      <VirtualGrid items={items} itemHeight={48} getKey={(i) => i.id} empty={empty} render={(it, idx) => (
        <div className={`listrow${selected.has(it.id) ? ' sel' : ''}`} onClick={(e) => onToggle(idx, e.shiftKey)}>
          <input type="checkbox" checked={selected.has(it.id)} readOnly aria-label={`Select ${it.originalName}`} />
          <Thumb item={it} />
          <span className={`badge ${it.type}`}>{LABEL[it.type]}</span>
          <span className="nm" title={`${it.originalName}.${it.ext}`}>{it.originalName}.{it.ext}</span>
          <span className="muted">&gt;&gt;{it.postNo}</span>
          <span className="muted" style={{ minWidth: 150, textAlign: 'right' }}>{meta(it)}{it.availability === 'broken' ? ' · broken' : ''}</span>
          <button className="ghost" onClick={(e) => { e.stopPropagation(); onPreview(idx); }} aria-label="Preview">Preview</button>
        </div>
      )} />
    );
  }
  return (
    <VirtualGrid items={items} itemHeight={196} minItemWidth={150} getKey={(i) => i.id} empty={empty} render={(it, idx) => (
      <div className={`card${selected.has(it.id) ? ' sel' : ''}${it.availability === 'broken' ? ' broken' : ''}`} onClick={(e) => onToggle(idx, e.shiftKey)}>
        <div className="thumb"><Thumb item={it} /></div>
        <label className="tl" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected.has(it.id)} onChange={() => onToggle(idx, false)} aria-label={`Select ${it.originalName}`} />
        </label>
        <div className="tr">
          {it.availability === 'broken' && <span className="badge" style={{ background: 'var(--bad)', color: '#fff' }}>missing</span>}
          <span className={`badge ${it.type}`}>{LABEL[it.type]}</span>
        </div>
        <div className="cap">
          <div title={`${it.originalName}.${it.ext}`}>{it.originalName}.{it.ext}</div>
          <div className="muted">&gt;&gt;{it.postNo}{meta(it) ? ` · ${meta(it)}` : ''}</div>
        </div>
        <button className="ghost" style={{ position: 'absolute', bottom: 34, right: 4, padding: '2px 6px', background: 'var(--panel)' }}
          onClick={(e) => { e.stopPropagation(); onPreview(idx); }} aria-label={`Preview ${it.originalName}`}>Preview</button>
      </div>
    )} />
  );
}
