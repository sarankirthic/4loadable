import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatBytes } from '../shared/media-filter';
import { TRASH_DIR } from '../shared/library-ops';
import type { LibraryEntry, LibrarySource } from '../shared/library-types';
import { VirtualGrid } from '../ui/VirtualGrid';

export const entryKey = (e: { path: string[] }) => e.path.join('/');
export type JobQueue = { schedule<T>(job: () => Promise<T>): Promise<T>; cancelAll(): void };

interface TreeNode { path: string[]; label: string; depth: number }

/** Left pane: library root, its top-level folders, and the chain of folders down to the current one.
 *  Every node is a navigation target and (when organizing) a drop target for dragged files. */
export function LibraryTree({ rootLabel, rootFolders, path, onNavigate, onDropTo }: {
  rootLabel: string; rootFolders: string[]; path: string[];
  onNavigate(p: string[]): void; onDropTo?: (p: string[]) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const nodes = useMemo(() => {
    const out: TreeNode[] = [{ path: [], label: rootLabel, depth: 0 }];
    for (const name of rootFolders) {
      out.push({ path: [name], label: name === TRASH_DIR ? 'Trash' : name, depth: 1 });
      if (path[0] === name) for (let i = 2; i <= path.length; i++) out.push({ path: path.slice(0, i), label: path[i - 1], depth: i });
    }
    return out;
  }, [rootLabel, rootFolders, path]);
  const cur = path.join('/');
  return (
    <VirtualGrid items={nodes} itemHeight={26} gap={2} getKey={(n) => `/${n.path.join('/')}`}
      render={(n) => {
        const k = n.path.join('/');
        return (
          <button className={`node${over === k ? ' drop' : ''}`} style={{ paddingLeft: 6 + n.depth * 12 }} title={n.label}
            aria-current={k === cur} onClick={() => onNavigate(n.path)}
            onDragOver={onDropTo ? (e) => { e.preventDefault(); setOver(k); } : undefined}
            onDragLeave={onDropTo ? () => setOver(null) : undefined}
            onDrop={onDropTo ? (e) => { e.preventDefault(); setOver(null); onDropTo(n.path); } : undefined}>
            {n.label}
          </button>
        );
      }} />
  );
}

interface ListProps {
  entries: LibraryEntry[];
  selected: Set<string>;
  source: LibrarySource;
  thumbs: JobQueue;
  draggable: boolean;
  onToggle(index: number, shift: boolean): void;
  onOpen(entry: LibraryEntry): void;
  onVisible(entry: LibraryEntry): void;
  onDragStart(entry: LibraryEntry): void;
  empty: ReactNode;
}

/** Right pane: virtualized rows for the current folder. */
export function EntryList({ entries, empty, ...rest }: ListProps) {
  return (
    <VirtualGrid items={entries} itemHeight={48} gap={4} getKey={entryKey} empty={empty}
      render={(e, i) => <EntryRow entry={e} index={i} {...rest} />} />
  );
}

const TYPE_LABEL = { image: 'IMG', gif: 'GIF', video: 'VID' } as const;

/** Lazy thumbnail + visibility tracking shared by the list row and grid card: bitmaps are
 *  decoded only while the element is on screen, and released again on scroll-out/unmount. */
function useEntryThumbnail(entry: LibraryEntry, wantsThumb: boolean, source: LibrarySource, thumbs: JobQueue, onVisible: (e: LibraryEntry) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ entry, onVisible });
  latest.current = { entry, onVisible };
  const key = entryKey(entry);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let bitmap: ImageBitmap | null = null;
    let visible = false, pending = false, dead = false;
    const release = () => {
      bitmap?.close(); bitmap = null;
      const c = canvas.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    };
    const draw = (b: ImageBitmap) => {
      const c = canvas.current; const ctx = c?.getContext('2d');
      if (!c || !ctx) return;
      const s = Math.min(c.width / b.width, c.height / b.height);
      const w = b.width * s, h = b.height * s;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(b, (c.width - w) / 2, (c.height - h) / 2, w, h);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (!visible) { release(); return; }
      latest.current.onVisible(latest.current.entry);
      if (!wantsThumb || bitmap || pending) return;
      pending = true;
      thumbs.schedule(() => (visible && !dead ? source.thumbnail(latest.current.entry) : Promise.resolve(null))).then((b) => {
        pending = false;
        if (!b) return;
        if (!visible || dead) { b.close(); return; }
        bitmap = b; draw(b);
      }, () => { pending = false; });
    });
    io.observe(el);
    return () => { dead = true; io.disconnect(); release(); };
  }, [key, wantsThumb, source, thumbs]);

  return { ref, canvas };
}

/** Right pane in grid mode: same entries, selection and click behavior as EntryList, as cards. */
export function EntryGrid({ entries, empty, ...rest }: ListProps) {
  return (
    <VirtualGrid items={entries} itemHeight={176} minItemWidth={140} gap={8} getKey={entryKey} empty={empty}
      render={(e, i) => <EntryCard entry={e} index={i} {...rest} />} />
  );
}

function EntryCard({ entry, index, selected, source, thumbs, draggable, onToggle, onOpen, onVisible, onDragStart }:
  Omit<ListProps, 'entries' | 'empty'> & { entry: LibraryEntry; index: number }) {
  const key = entryKey(entry);
  const wantsThumb = source.id === 'folder' && entry.kind === 'file' && entry.mediaType === 'image';
  const { ref, canvas } = useEntryThumbnail(entry, wantsThumb, source, thumbs, onVisible);
  const sel = selected.has(key);
  const isTrash = entry.kind === 'folder' && entry.path.length === 1 && entry.name === TRASH_DIR;
  const subtitle = entry.kind === 'folder' ? `${entry.fileCount ?? '—'} files`
    : entry.size != null ? formatBytes(entry.size) : '—';
  return (
    <div ref={ref} className={`card${sel ? ' sel' : ''}${entry.missing ? ' broken' : ''}`} draggable={draggable && entry.kind === 'file'}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', key); onDragStart(entry); }}>
      <label className="tl" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={sel} aria-label={`Select ${entry.name}`} onChange={() => {}} onClick={(e) => onToggle(index, e.shiftKey)} />
      </label>
      {entry.missing && <div className="tr"><span className="badge" style={{ background: 'var(--bad)', color: '#fff' }}>missing</span></div>}
      <button className="ghost thumb" onClick={() => onOpen(entry)} aria-label={isTrash ? 'Trash' : entry.name}>
        {wantsThumb ? <canvas ref={canvas} width={140} height={140} aria-hidden="true" />
          : entry.kind === 'folder' ? <span className="badge" style={{ background: 'var(--line)', color: 'var(--text)' }}>DIR</span>
            : entry.mediaType ? <span className={`badge ${entry.mediaType}`}>{TYPE_LABEL[entry.mediaType]}</span>
              : <span className="badge" style={{ background: 'var(--line)', color: 'var(--text)' }}>FILE</span>}
      </button>
      <div className="cap">
        <div title={entry.path.join('/')}>{isTrash ? 'Trash' : entry.name}</div>
        <div className="muted">{subtitle}</div>
      </div>
    </div>
  );
}

function EntryRow({ entry, index, selected, source, thumbs, draggable, onToggle, onOpen, onVisible, onDragStart }:
  Omit<ListProps, 'entries' | 'empty'> & { entry: LibraryEntry; index: number }) {
  const wantsThumb = source.id === 'folder' && entry.kind === 'file' && entry.mediaType === 'image';
  const { ref, canvas } = useEntryThumbnail(entry, wantsThumb, source, thumbs, onVisible);
  const key = entryKey(entry);
  const sel = selected.has(key);
  const size = entry.kind === 'folder' ? entry.totalSize : entry.size;
  return (
    <div ref={ref} className={`treerow${sel ? ' sel' : ''}${entry.missing ? ' missing' : ''}`} draggable={draggable && entry.kind === 'file'}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', key); onDragStart(entry); }}>
      <input type="checkbox" checked={sel} aria-label={`Select ${entry.name}`}
        onChange={() => {}} onClick={(e) => onToggle(index, e.shiftKey)} />
      {wantsThumb ? <canvas ref={canvas} width={80} height={80} aria-hidden="true" />
        : entry.kind === 'folder' ? <span className="badge" style={{ background: 'var(--line)', color: 'var(--text)' }}>DIR</span>
          : entry.mediaType ? <span className={`badge ${entry.mediaType}`}>{TYPE_LABEL[entry.mediaType]}</span>
            : <span className="badge" style={{ background: 'var(--line)', color: 'var(--text)' }}>FILE</span>}
      <button className="ghost nm" title={entry.path.join('/')} onClick={() => onOpen(entry)}>
        {entry.kind === 'folder' && entry.path.length === 1 && entry.name === TRASH_DIR ? 'Trash' : entry.name}
      </button>
      {entry.missing && <span className="st failed">missing</span>}
      {entry.kind === 'folder' && <span className="muted">{entry.fileCount ?? '—'} files</span>}
      <span className="muted">{size != null ? formatBytes(size) : '—'}</span>
      <span className="muted">{entry.modifiedAt != null ? new Date(entry.modifiedAt).toLocaleDateString() : '—'}</span>
    </div>
  );
}
