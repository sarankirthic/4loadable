import { useEffect } from 'react';
import { formatBytes } from '../shared/media-filter';
import type { MediaItem } from '../shared/types';

interface Props { items: MediaItem[]; index: number; selected: Set<string>; onClose(): void; onNav(i: number): void; onToggle(id: string): void }

/** Loads the full file only for the one item being previewed; the grid itself uses thumbnails. */
export function PreviewModal({ items, index, selected, onClose, onNav, onToggle }: Props) {
  const it = items[index];
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && index < items.length - 1) onNav(index + 1);
      else if (e.key === 'ArrowLeft' && index > 0) onNav(index - 1);
      else if (e.key === ' ') { e.preventDefault(); onToggle(it.id); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [index, items.length, onClose, onNav, onToggle, it]);
  if (!it) return null;
  return (
    <div className="modal-bg" onClick={onClose} role="dialog" aria-modal="true" aria-label="Preview">
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <strong className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.originalName}.{it.ext}</strong>
          <span className="muted">&gt;&gt;{it.postNo}{it.size != null ? ` · ${formatBytes(it.size)}` : ''}</span>
          <button onClick={() => onToggle(it.id)}>{selected.has(it.id) ? 'Deselect' : 'Select'}</button>
          <button onClick={onClose} aria-label="Close preview">Close</button>
        </div>
        {it.type === 'video'
          ? <video key={it.id} className="preview-media" src={it.url} controls autoPlay muted loop playsInline preload="metadata" />
          : <img key={it.id} className="preview-media" src={it.url} alt={it.originalName} referrerPolicy="no-referrer" />}
        <div className="row">
          <button disabled={index === 0} onClick={() => onNav(index - 1)}>Previous</button>
          <span className="muted">{index + 1} of {items.length} · use ← → keys, space to select</span>
          <button disabled={index >= items.length - 1} onClick={() => onNav(index + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
