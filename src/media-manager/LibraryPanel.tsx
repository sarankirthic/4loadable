import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { executePlan, undoLast, type JournalEntry, type JournalStore } from '../shared/library-executor';
import { classifyPermission, indexedDBHandleStore, isLikelyDownloadsRoot, pickerErrorHint, type FolderPermissionState, type HandleStore } from '../shared/library-folder-store';
import { createFsLike } from '../shared/library-fs';
import { TRASH_DIR } from '../shared/library-ops';
import { createBrowserRecordsSource } from '../shared/library-source-browser';
import { createFolderSource, type DirHandleLike } from '../shared/library-source-folder';
import { createThumbnailQueue } from '../shared/library-thumbnails';
import { filterEntries, sortEntries, type SortKey } from '../shared/library-tree';
import type { LibraryEntry, LibrarySource, LibrarySourceId } from '../shared/library-types';
import { sanitizeFolderPath } from '../shared/filename-utils';
import { formatBytes } from '../shared/media-filter';
import { send as sendMsg, type Msg } from '../shared/messaging';
import type { MediaType } from '../shared/types';
import { LibraryOrganizeBar, movePlanRequest } from './LibraryOrganizeBar';
import { LibraryPreviewModal } from './LibraryPreviewModal';
import { EntryList, entryKey, LibraryTree } from './LibraryTree';
import { opLabel, OperationPreviewDialog, type PlanRequest, type RunFn } from './OperationPreviewDialog';

type Mode = 'read' | 'readwrite';
/** A File System Access directory handle (or a test fake with the same shape). */
export interface RootDirHandle extends DirHandleLike {
  queryPermission?(o: { mode: Mode }): Promise<PermissionState>;
  requestPermission?(o: { mode: Mode }): Promise<PermissionState>;
}

/** Everything the panel needs from the outside world — injectable so tests can mount it with fakes. */
export interface LibraryDeps {
  handleStore: HandleStore<RootDirHandle>;
  /** null when the browser has no showDirectoryPicker. */
  pickDirectory: ((o: { mode: 'read' }) => Promise<RootDirHandle>) | null;
  /** null when chrome.downloads isn't available. Resolves null when no download records sit under the root folder. */
  browserSource: (() => Promise<LibrarySource | null>) | null;
  removeDownload?(id: number): Promise<void>;
  showDefaultFolder?(): Promise<void>;
  journal: JournalStore;
  send(msg: Msg): void;
}

/** Absolute prefix (through the configured root folder) of the first download record that contains it. */
function findBaseFolder(filenames: string[], rootFolder: string): string | null {
  const segs = sanitizeFolderPath(rootFolder).map((s) => s.toLowerCase());
  if (!segs.length) return null;
  for (const f of filenames) {
    const parts = f.replace(/\\/g, '/').split('/');
    for (let i = 0; i + segs.length <= parts.length - 1; i++) {
      if (segs.every((s, j) => parts[i + j].toLowerCase() === s)) return parts.slice(0, i + segs.length).join('/');
    }
  }
  return null;
}

export function chromeLibraryDeps(rootFolder: string): LibraryDeps {
  const c = (globalThis as any).chrome;
  const picker = (globalThis as any).showDirectoryPicker;
  const JOURNAL_KEY = 'libraryJournal';
  return {
    handleStore: indexedDBHandleStore<RootDirHandle>(),
    pickDirectory: typeof picker === 'function' ? (o) => picker(o) : null,
    browserSource: c?.downloads ? async () => {
      const search = (q: { state?: 'complete' }) => c.downloads.search(q);
      const items: Array<{ filename: string }> = await search({ state: 'complete' });
      const baseFolder = findBaseFolder(items.map((i) => i.filename), rootFolder);
      if (!baseFolder) return null;
      return createBrowserRecordsSource({ search, baseFolder, show: async (id) => c.downloads.show(id) });
    } : null,
    removeDownload: c?.downloads ? async (id) => { await c.downloads.removeFile(id); } : undefined,
    showDefaultFolder: c?.downloads ? async () => { c.downloads.showDefaultFolder(); } : undefined,
    journal: {
      load: async () => ((await c.storage.local.get(JOURNAL_KEY))[JOURNAL_KEY] as JournalEntry[] | undefined) ?? [],
      save: (j) => c.storage.local.set({ [JOURNAL_KEY]: j }),
    },
    send: (m) => { void sendMsg(m); },
  };
}

const PERM_MESSAGE: Partial<Record<FolderPermissionState, string>> = {
  unsupported: 'This browser cannot open a folder directly (no File System Access API), so only Chrome’s download records are shown.',
  disconnected: 'No library folder is connected. Choose your download folder to see thumbnails, preview files and organize them.',
  'needs-reconnect': 'Chrome needs your permission again to read the library folder.',
  denied: 'Access to the library folder was denied. Choose the folder again to allow access.',
};
const TYPE_OPTIONS: [string, string][] = [['', 'All types'], ['image', 'Images'], ['gif', 'GIFs'], ['video', 'Videos']];

interface Props { rootFolder: string; notify(m: string): void; queueActive: boolean; deps?: LibraryDeps }

export function LibraryPanel({ rootFolder, notify, queueActive, deps: injected }: Props) {
  const deps = useMemo(() => injected ?? chromeLibraryDeps(rootFolder), [injected, rootFolder]);
  const [perm, setPerm] = useState<FolderPermissionState | null>(null);
  const [handle, setHandle] = useState<RootDirHandle | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [browser, setBrowser] = useState<LibrarySource | null | undefined>(undefined);
  const [mode, setMode] = useState<LibrarySourceId | null>(null);
  const [pickNote, setPickNote] = useState<string | null>(null);

  const [path, setPath] = useState<string[]>([]);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [rootFolders, setRootFolders] = useState<string[]>([]);
  const [scan, setScan] = useState<{ running: boolean; found: number; error: boolean; cancelled: boolean }>({ running: false, found: 0, error: false, cancelled: false });
  const cancelScan = useRef<() => void>(() => {});
  const [reload, setReload] = useState(0);
  const [stats, setStats] = useState<Record<string, { size: number; modifiedAt: number }>>({});

  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef(0);
  const [preview, setPreview] = useState<number | null>(null);
  const [planReq, setPlanReq] = useState<PlanRequest | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const dragged = useRef<LibraryEntry[]>([]);

  const thumbs = useMemo(() => createThumbnailQueue(4), []);
  const statQueue = useMemo(() => createThumbnailQueue(4), []);
  useEffect(() => () => { thumbs.cancelAll(); statQueue.cancelAll(); }, [thumbs, statQueue]);

  // --- permission state (queryPermission only; requestPermission happens on explicit clicks) ---
  const check = useCallback(async (h: RootDirHandle | null) => {
    const q = async (m: Mode) => { try { return await h?.queryPermission?.({ mode: m }); } catch { return undefined; } };
    setPerm(classifyPermission({ supported: !!deps.pickDirectory, hasHandle: !!h, read: h ? await q('read') : undefined, write: h ? await q('readwrite') : undefined }));
  }, [deps]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const h = deps.pickDirectory ? await deps.handleStore.get().catch(() => null) : null;
      if (!alive) return;
      setHandle(h);
      await check(h);
    })();
    if (deps.browserSource) deps.browserSource().then((s) => alive && setBrowser(s), () => alive && setBrowser(null));
    else setBrowser(null);
    void deps.journal.load().then((j) => alive && setCanUndo(j.length > 0), () => {});
    return () => { alive = false; };
  }, [deps, check]);

  const folderUsable = !!handle && (perm === 'read' || perm === 'write');
  const writable = folderUsable && perm === 'write' && organizing;
  const sourceId: LibrarySourceId | null = folderUsable && (mode !== 'browser-records' || !browser) ? 'folder' : browser ? 'browser-records' : null;
  const source = useMemo<LibrarySource | null>(() => {
    if (sourceId === 'folder' && handle) return createFolderSource(handle, { writable });
    return sourceId === 'browser-records' ? browser ?? null : null;
  }, [sourceId, handle, writable, browser]);
  // Same root handle as the folder source; FsLike is a separate object (createFolderSource has no .fs).
  const fs = useMemo(() => (sourceId === 'folder' && handle && writable ? createFsLike(handle) : null), [sourceId, handle, writable]);
  const organize = !!(source?.canOrganize && fs);

  useEffect(() => { setPath([]); setStats({}); }, [source?.id, handle]);
  useEffect(() => { setSelected(new Set()); setPreview(null); }, [path, source]);

  // --- scan the current folder: one AbortController per navigation, flushed in batches ---
  const pathKey = path.join('/');
  useEffect(() => {
    if (!source) { setEntries([]); return; }
    const ac = new AbortController();
    let buf: LibraryEntry[] = [], raf = 0, found = 0;
    const flush = () => {
      cancelAnimationFrame(raf); raf = 0;
      if (buf.length) { const b = buf; buf = []; setEntries((prev) => prev.concat(b)); }
      setScan((s) => ({ ...s, found }));
    };
    setEntries([]);
    setScan({ running: true, found: 0, error: false, cancelled: false });
    cancelScan.current = () => { ac.abort(); flush(); setScan((s) => ({ ...s, running: false, cancelled: true })); };
    void (async () => {
      try {
        for await (const e of source.list(path, ac.signal)) {
          if (ac.signal.aborted) return;
          buf.push(e); found++;
          if (buf.length >= 200) flush(); else if (!raf) raf = requestAnimationFrame(flush);
        }
        if (!ac.signal.aborted) { flush(); setScan((s) => ({ ...s, running: false })); }
      } catch {
        if (!ac.signal.aborted) { flush(); setScan((s) => ({ ...s, running: false, error: true })); }
      }
    })();
    return () => { ac.abort(); cancelAnimationFrame(raf); thumbs.cancelAll(); statQueue.cancelAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, pathKey, reload]);

  useEffect(() => {
    if (!source) { setRootFolders([]); return; }
    const ac = new AbortController();
    void (async () => {
      const names: string[] = [];
      try { for await (const e of source.list([], ac.signal)) if (e.kind === 'folder') names.push(e.name); } catch { /* shown by the main scan */ }
      if (!ac.signal.aborted) setRootFolders(names.sort((a, b) => a.localeCompare(b)));
    })();
    return () => ac.abort();
  }, [source, reload]);

  // --- lazy stat (folder source only; browser records already carry size/date) ---
  const statPending = useRef(new Set<string>());
  const statBuf = useRef<Record<string, { size: number; modifiedAt: number }>>({});
  const statRaf = useRef(0);
  useEffect(() => { statPending.current.clear(); statBuf.current = {}; }, [source, reload]);
  const requestStat = useCallback((e: LibraryEntry): Promise<void> => {
    const k = entryKey(e);
    if (!source || source.id !== 'folder' || e.kind !== 'file' || statPending.current.has(k)) return Promise.resolve();
    statPending.current.add(k);
    return statQueue.schedule(() => source.stat(e)).then((s) => {
      if (!s) return;
      statBuf.current[k] = s;
      if (!statRaf.current) statRaf.current = requestAnimationFrame(() => {
        statRaf.current = 0;
        const b = statBuf.current; statBuf.current = {};
        setStats((prev) => ({ ...prev, ...b }));
      });
    }, () => { statPending.current.delete(k); });
  }, [source, statQueue]);

  const merged = useMemo(() => entries.map((e) => { const s = stats[entryKey(e)]; return s ? { ...e, ...s } : e; }), [entries, stats]);
  const shown = useMemo(() => sortEntries(filterEntries(merged, { query, types: type ? [type as MediaType] : undefined }), sortKey, sortDir), [merged, query, type, sortKey, sortDir]);
  const files = useMemo(() => shown.filter((e) => e.kind === 'file'), [shown]);
  const selection = useMemo(() => shown.filter((e) => selected.has(entryKey(e))), [shown, selected]);
  const missing = useMemo(() => entries.filter((e) => e.missing).length, [entries]);

  useEffect(() => { if (sortKey !== 'name') for (const e of entries) void requestStat(e); }, [sortKey, entries, requestStat]);

  // Sort-by-month needs dates for every file, visible or not.
  const withStats = (list: LibraryEntry[]) => Promise.all(list.map(async (e) => {
    if (e.modifiedAt !== undefined || !source) return e;
    const s = await statQueue.schedule(() => source.stat(e)).catch(() => null);
    return s ? { ...e, ...s } : e;
  }));

  const onToggle = useCallback((index: number, shift: boolean) => {
    const it = shown[index];
    if (!it) return;
    const on = !selected.has(entryKey(it));
    const n = new Set(selected);
    const [a, b] = shift ? [Math.min(anchor.current, index), Math.max(anchor.current, index)] : [index, index];
    for (let i = a; i <= b; i++) { const k = shown[i] && entryKey(shown[i]); if (k) on ? n.add(k) : n.delete(k); }
    setSelected(n);
    anchor.current = index;
  }, [shown, selected]);

  // --- actions ---
  const choose = async () => {
    if (!deps.pickDirectory) return;
    try {
      const h = await deps.pickDirectory({ mode: 'read' });
      await deps.handleStore.set(h).catch(() => {});
      setHandle(h); setOrganizing(false); setMode(null);
      setPickNote(isLikelyDownloadsRoot(h.name)
        ? `"${h.name}" looks like your whole Downloads folder. That works, but unrelated downloads will show up too; consider choosing the ${rootFolder} folder inside it.`
        : null);
      await check(h);
    } catch (err) {
      const hint = pickerErrorHint(err, rootFolder);
      setPickNote(hint ? `No folder was connected. If Chrome refused that folder, ${hint}.` : 'Could not open that folder.');
    }
  };
  const reconnect = async () => {
    try { await handle?.requestPermission?.({ mode: 'read' }); } catch { /* state re-check below explains it */ }
    await check(handle);
  };
  const enableOrganizing = async () => {
    let r: PermissionState | undefined;
    try { r = await handle?.requestPermission?.({ mode: 'readwrite' }); } catch { r = 'denied'; }
    if (r === 'granted') { setPerm('write'); setOrganizing(true); } else notify('Write access was not granted, so the library stays read-only.');
  };
  const refresh = () => { setReload((n) => n + 1); void deps.journal.load().then((j) => setCanUndo(j.length > 0), () => {}); };

  const runOps: RunFn = async (ops, signal, onProgress) => {
    const r = await executePlan(ops, fs!, deps.journal, { signal, onProgress });
    const last = (await deps.journal.load()).at(-1);
    const changes = (last?.ops ?? []).filter((o) => o.done && o.kind !== 'mkdir' && o.from && o.to).map((o) => ({ from: o.from!, to: o.to! }));
    if (changes.length) deps.send({ type: 'LIBRARY_PATHS_CHANGED', changes });
    return { done: r.done, failed: r.failed.map((f) => ({ label: opLabel(f.op), error: f.error })) };
  };

  const undo = async () => {
    const before = (await deps.journal.load()).at(-1);
    if (!before || !fs) return;
    const pending = before.ops.filter((o) => o.done && o.kind !== 'mkdir' && o.from && o.to);
    if (!pending.length) {
      // Nothing to preview (e.g. New folder, or a run where nothing completed): drop the entry so earlier actions stay undoable.
      await undoLast(fs, deps.journal).catch(() => {});
      notify('Nothing to reverse in the last action (new folders are kept).');
      refresh();
      return;
    }
    setPlanReq({
      title: 'Undo last',
      cancellable: false,
      plan: async () => ({
        ops: pending.map((o) => ({ kind: o.kind, from: o.to, to: o.from })),
        skipped: [],
        warnings: before.ops.some((o) => !o.done) ? ['Some steps of that run never completed; only the completed ones are reversed.'] : [],
      }),
      run: async (_ops, _signal, onProgress) => {
        const r = await undoLast(fs, deps.journal);
        onProgress(r.undone, pending.length);
        const after = (await deps.journal.load()).at(-1);
        const stillDone = new Set(after?.id === before.id ? after.ops.flatMap((o, i) => (o.done ? [i] : [])) : []);
        // ponytail: reports the original location; if undo had to suffix "-2" because it was taken, history keeps the unsuffixed path.
        const changes = before.ops.flatMap((o, i) => (o.done && o.kind !== 'mkdir' && o.from && o.to && !stillDone.has(i) ? [{ from: o.to, to: o.from }] : []));
        if (changes.length) deps.send({ type: 'LIBRARY_PATHS_CHANGED', changes });
        return { done: r.undone, failed: Array.from({ length: r.failed }, () => ({ label: 'Undo step', error: 'could not be reversed; it stays in the journal so Undo can retry it' })) };
      },
    });
  };

  const emptyTrash = async () => {
    if (!fs) return;
    try {
      if ((await fs.exists([TRASH_DIR])) !== 'folder') { notify('The trash is empty.'); return; }
      const found: string[][] = [];
      const walk = async (p: string[]): Promise<void> => { for (const e of await fs.list(p)) e.kind === 'folder' ? await walk([...p, e.name]) : found.push([...p, e.name]); };
      await walk([TRASH_DIR]);
      if (!found.length) { notify('The trash is empty.'); return; }
      let bytes = 0;
      for (const f of found) bytes += await fs.size(f).catch(() => 0);
      if (!confirm(`Permanently delete ${found.length} file${found.length === 1 ? '' : 's'} (${formatBytes(bytes)}) from the trash? This cannot be undone.`)) return;
      const removed: string[][] = [];
      for (const f of found) { try { await fs.remove(f); removed.push(f); } catch { /* counted below */ } }
      // Empty `to` = permanently deleted: clears the history record's libraryPath.
      if (removed.length) deps.send({ type: 'LIBRARY_PATHS_CHANGED', changes: removed.map((from) => ({ from, to: [] })) });
      notify(`Deleted ${removed.length} file${removed.length === 1 ? '' : 's'} from the trash${removed.length < found.length ? `, ${found.length - removed.length} could not be deleted` : ''}.`);
    } catch {
      notify('Could not read the trash folder.');
    }
    refresh();
  };

  const deleteFromDisk = async () => {
    const targets = selection.filter((e) => e.kind === 'file' && e.downloadId !== undefined && !e.missing);
    if (!targets.length || !deps.removeDownload) return;
    if (!confirm(`Delete ${targets.length} file${targets.length === 1 ? '' : 's'} from disk? This cannot be undone.`)) return;
    let failed = 0;
    for (const t of targets) { try { await deps.removeDownload(t.downloadId!); } catch { failed++; } }
    notify(`Deleted ${targets.length - failed} file${targets.length - failed === 1 ? '' : 's'}${failed ? `, ${failed} could not be deleted` : ''}.`);
    refresh();
  };
  const reveal = (e?: LibraryEntry) => {
    if (e && source?.revealInOS && e.downloadId !== undefined) void source.revealInOS(e).catch(() => {});
    else void deps.showDefaultFolder?.().catch(() => {});
  };

  const onOpen = (e: LibraryEntry) => { if (e.kind === 'folder') setPath(e.path); else setPreview(files.indexOf(e)); };
  const onDragStart = (e: LibraryEntry) => { dragged.current = selected.has(entryKey(e)) ? selection.filter((s) => s.kind === 'file') : [e]; };
  const onDropTo = organize ? (dest: string[]) => { if (dragged.current.length && fs) setPlanReq(movePlanRequest(dragged.current, dest, fs)); } : undefined;

  // --- render ---
  const permMsg = perm ? PERM_MESSAGE[perm] : undefined;
  const rootLabel = sourceId === 'folder' ? handle?.name ?? 'Library' : 'Download records';
  const empty = scan.running ? <div className="empty">Scanning…</div>
    : scan.error ? <div className="empty">Could not read this folder. It may have been moved, renamed or deleted outside the extension.</div>
      : entries.length ? <div className="empty">Nothing here matches the search or filter.</div>
        : <div className="empty">This folder is empty.</div>;

  return (
    <div className="main">
      <div className="toolbar">
        <div className="row">
          {folderUsable && browser && (
            <div className="row" role="radiogroup" aria-label="Library source">
              <span>Source:</span>
              <label><input type="radio" checked={sourceId === 'folder'} onChange={() => setMode('folder')} /> Library folder</label>
              <label><input type="radio" checked={sourceId === 'browser-records'} onChange={() => setMode('browser-records')} /> Download records</label>
            </div>
          )}
          {!folderUsable && sourceId === 'browser-records' && <span className="muted">Showing Chrome’s download records.</span>}
          <span className="grow" />
          {perm === 'needs-reconnect' && <button className="primary" onClick={reconnect}>Reconnect</button>}
          {deps.pickDirectory && <button onClick={choose}>{handle ? 'Choose a different folder' : 'Choose library folder'}</button>}
        </div>
        {permMsg && <div className={`notice${perm === 'denied' ? ' bad' : ''}`}>{permMsg}</div>}
        {pickNote && <div className="notice" role="note">{pickNote}</div>}
        {sourceId === 'browser-records' && <div className="muted">Connect a folder for thumbnails and local preview.</div>}
        {sourceId === 'folder' && !writable && (
          <div className="row">
            <button onClick={enableOrganizing}>Enable organizing</button>
            <span className="muted">Asks Chrome for write access to this folder so you can move, rename and trash files here; nothing changes until you confirm each action.</span>
          </div>
        )}
      </div>

      {perm === null || browser === undefined ? <div className="empty">Loading library…</div>
        : !source ? <div className="empty">{deps.pickDirectory ? 'Choose your library folder to get started.' : 'No downloads from this extension were found in Chrome’s download records.'}</div>
          : (
            <div className="lib">
              <aside className="tree" aria-label="Folders">
                <LibraryTree rootLabel={rootLabel} rootFolders={rootFolders} path={path} onNavigate={setPath} onDropTo={onDropTo} />
              </aside>
              <section className="pane">
                <div className="toolbar">
                  <nav className="crumbs" aria-label="Breadcrumbs">
                    <button onClick={() => setPath([])}>{rootLabel}</button>
                    {path.map((seg, i) => <span key={i}>/<button onClick={() => setPath(path.slice(0, i + 1))}>{seg === TRASH_DIR && i === 0 ? 'Trash' : seg}</button></span>)}
                  </nav>
                  <div className="row">
                    <input type="text" placeholder="Search file names" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search file names" />
                    <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
                      {TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} aria-label="Sort by">
                      <option value="name">Name</option><option value="date">Date</option><option value="size">Size</option>
                    </select>
                    <button onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')} aria-label="Sort direction">{sortDir === 'asc' ? '↑' : '↓'}</button>
                    <button disabled={!shown.length} onClick={() => setSelected(new Set(shown.map(entryKey)))}>Select all in folder</button>
                    <button disabled={!selected.size} onClick={() => setSelected(new Set())}>Select none</button>
                    <span className="muted">{shown.length} of {entries.length}</span>
                  </div>
                  {scan.running && (
                    <div className="row" role="status"><span>{scan.found} files found…</span><div className="bar indeterminate grow"><i /></div>
                      <button onClick={() => cancelScan.current()}>Cancel</button></div>
                  )}
                  {scan.cancelled && <div className="notice">Scan cancelled; showing the {scan.found} entries found so far.</div>}
                  {missing > 0 && <div className="notice">{missing} item{missing === 1 ? '' : 's'} here {missing === 1 ? 'is' : 'are'} missing from disk (moved or deleted outside the extension).</div>}
                </div>
                {organize && fs && (
                  <LibraryOrganizeBar path={path} selection={selection} folderFiles={files} fs={fs} canUndo={canUndo}
                    onRequest={setPlanReq} onUndo={() => void undo()} onEmptyTrash={() => void emptyTrash()} onReadOnly={() => setOrganizing(false)} withStats={withStats} />
                )}
                <EntryList entries={shown} selected={selected} source={source} thumbs={thumbs} draggable={organize}
                  onToggle={onToggle} onOpen={onOpen} onVisible={(e) => void requestStat(e)} onDragStart={onDragStart} empty={empty} />
                <div className="actionbar">
                  <strong>{selected.size} selected</strong>
                  <span className="grow" />
                  {sourceId === 'browser-records' && (<>
                    <button onClick={() => reveal(selection.length === 1 ? selection[0] : undefined)}>Show in folder</button>
                    {deps.removeDownload && <button className="danger" disabled={!selection.some((e) => e.kind === 'file' && e.downloadId !== undefined && !e.missing)}
                      onClick={() => void deleteFromDisk()}>Delete from disk</button>}
                  </>)}
                </div>
              </section>
            </div>
          )}

      {preview != null && source && preview >= 0 && (
        <LibraryPreviewModal source={source} files={files} index={preview} onNav={setPreview} onClose={() => setPreview(null)}
          onReveal={sourceId === 'browser-records' ? reveal : undefined} />
      )}
      {planReq && fs && (
        <OperationPreviewDialog {...planReq} run={planReq.run ?? runOps} queueActive={queueActive}
          onPauseQueue={() => deps.send({ type: 'QUEUE_ACTION', action: 'pauseAll' })}
          onClose={(ran) => { setPlanReq(null); if (ran) { setSelected(new Set()); refresh(); } }} />
      )}
    </div>
  );
}
