import { useEffect, useState } from 'react';
import { findManifestRecord, isManifestName, manifestDirFor, MANIFEST_MAX_BYTES, parseThreadManifest, type ManifestFileRecord } from '../shared/library-manifest';
import type { LibraryEntry, LibrarySource } from '../shared/library-types';
import { formatBytes } from '../shared/media-filter';
import { entryKey } from './LibraryTree';

interface Props { source: LibrarySource; files: LibraryEntry[]; index: number; onNav(i: number): void; onClose(): void; onReveal?(e: LibraryEntry): void }

/** Finds this file's record in a manifest*.json in its thread folder (size-checked before parsing). */
async function loadManifestRecord(source: LibrarySource, entry: LibraryEntry, signal: AbortSignal): Promise<ManifestFileRecord | undefined> {
  const dir = manifestDirFor(entry.path.slice(0, -1));
  const candidates: LibraryEntry[] = [];
  for await (const e of source.list(dir, signal)) if (e.kind === 'file' && isManifestName(e.name)) candidates.push(e);
  for (const c of candidates) {
    if (signal.aborted) return undefined;
    const blob = await source.open(c);
    if (!blob || blob.size > MANIFEST_MAX_BYTES) continue;
    const rec = findManifestRecord(parseThreadManifest(await blob.text()), entry.name);
    if (rec) return rec;
  }
  return undefined;
}

/** Loads the one previewed file into an object URL (revoked on change/close). All text goes through JSX. */
export function LibraryPreviewModal({ source, files, index, onNav, onClose, onReveal }: Props) {
  const entry = files[index];
  const key = entry ? entryKey(entry) : '';
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'none' | 'error'>('loading');
  const [size, setSize] = useState<number | undefined>(undefined);
  const [record, setRecord] = useState<ManifestFileRecord | undefined>(undefined);

  useEffect(() => {
    if (!entry) return;
    let alive = true, u: string | null = null;
    setUrl(null); setState('loading'); setSize(entry.size);
    source.open(entry).then((b) => {
      if (!alive) return;
      if (!b) { setState('none'); return; }
      u = URL.createObjectURL(b); setUrl(u); setSize(b.size); setState('ok');
    }).catch(() => alive && setState('error'));
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source]);

  useEffect(() => {
    if (!entry || source.id !== 'folder') return;
    const ac = new AbortController();
    setRecord(undefined);
    loadManifestRecord(source, entry, ac.signal).then((r) => !ac.signal.aborted && setRecord(r), () => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && index < files.length - 1) onNav(index + 1);
      else if (e.key === 'ArrowLeft' && index > 0) onNav(index - 1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [index, files.length, onClose, onNav]);

  if (!entry) return null;
  return (
    <div className="modal-bg" onClick={onClose} role="dialog" aria-modal="true" aria-label="Preview">
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <strong className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</strong>
          <span className="muted">{size != null ? formatBytes(size) : '—'}</span>
          {onReveal && <button onClick={() => onReveal(entry)}>Show in folder</button>}
          <button onClick={onClose} aria-label="Close preview">Close</button>
        </div>
        <div className="muted" style={{ overflowWrap: 'anywhere' }}>{entry.path.join('/')}</div>
        {state === 'loading' && <div className="empty">Loading…</div>}
        {state === 'none' && <div className="empty">{source.id === 'browser-records' ? 'Connect a folder for thumbnails and local preview.' : 'This file cannot be previewed.'}</div>}
        {state === 'error' && <div className="empty">Could not read this file. It may have been moved or deleted.</div>}
        {state === 'ok' && url && (entry.mediaType === 'video'
          ? <video key={url} className="preview-media" src={url} controls autoPlay muted loop playsInline />
          : <img key={url} className="preview-media" src={url} alt={entry.name} />)}
        {record && (
          <div className="field" aria-label="Manifest details">
            <span className="muted">Original name</span><span>{record.originalFilename}</span>
            <span className="muted">Post</span><span>&gt;&gt;{record.postNumber}</span>
            <span className="muted">Source</span>
            <span style={{ overflowWrap: 'anywhere' }}>
              {/^https:\/\//i.test(record.sourceUrl) ? <a href={record.sourceUrl} target="_blank" rel="noreferrer noopener">{record.sourceUrl}</a> : record.sourceUrl}
            </span>
          </div>
        )}
        <div className="row">
          <button disabled={index === 0} onClick={() => onNav(index - 1)}>Previous</button>
          <span className="muted">{index + 1} of {files.length} · use ← → keys</span>
          <button disabled={index >= files.length - 1} onClick={() => onNav(index + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
