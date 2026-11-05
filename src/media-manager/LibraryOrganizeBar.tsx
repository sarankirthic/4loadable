import { useEffect, useState, type ReactNode } from 'react';
import type { FsLike } from '../shared/library-fs';
import { planBulkRename, planMove, planRename, planSort, planTrash, TRASH_DIR, type ExistingFn, type Op, type PlanResult, type SortRule } from '../shared/library-ops';
import { isSafeName } from '../shared/library-paths';
import type { LibraryEntry } from '../shared/library-types';
import { opLabel, type PlanRequest } from './OperationPreviewDialog';

export const existsIn = (fs: FsLike): ExistingFn => async (p) => (await fs.exists(p)) !== null;

export function movePlanRequest(files: LibraryEntry[], dest: string[], fs: FsLike): PlanRequest {
  return {
    title: `Move ${files.length} file${files.length === 1 ? '' : 's'} to ${dest.length ? dest.join('/') : 'the library root'}`,
    collisionChoice: true,
    plan: (c) => planMove(files, dest, c, existsIn(fs)),
  };
}

const NAME_RULES = 'Names cannot be empty, "." or "..", contain / or \\ or control characters, or be longer than 200 characters.';

function Dialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal" onClick={(e) => e.stopPropagation()}><h2>{title}</h2>{children}</div>
    </div>
  );
}

function NamePrompt({ title, initial, onSubmit, onClose }: { title: string; initial: string; onSubmit(name: string): void; onClose(): void }) {
  const [v, setV] = useState(initial);
  const valid = isSafeName(v) && v.trim() !== '';
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit(v); }}>
        <input type="text" className="grow" autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-label="Name" aria-invalid={!valid} />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary" disabled={!valid}>Continue</button>
      </form>
      {!valid && v !== '' && <div className="notice bad" role="alert">{NAME_RULES}</div>}
    </Dialog>
  );
}

function BulkRenamePrompt({ files, fs, onSubmit, onClose }: { files: LibraryEntry[]; fs: FsLike; onSubmit(tpl: string): void; onClose(): void }) {
  const [tpl, setTpl] = useState('{original}-{n}');
  const [preview, setPreview] = useState<PlanResult | null>(null);
  useEffect(() => {
    let alive = true;
    // ponytail: previews the first 8 files only, so typing doesn't stat the whole selection per keystroke.
    planBulkRename(files.slice(0, 8), tpl, 'rename', existsIn(fs)).then((p) => alive && setPreview(p), () => alive && setPreview(null));
    return () => { alive = false; };
  }, [tpl, files, fs]);
  return (
    <Dialog title={`Bulk rename ${files.length} file${files.length === 1 ? '' : 's'}`} onClose={onClose}>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (tpl.trim()) onSubmit(tpl); }}>
        <input type="text" className="grow" autoFocus value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Name template" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary" disabled={!tpl.trim()}>Continue</button>
      </form>
      <div className="muted">Use {'{original}'}, {'{n}'}, {'{ext}'}, {'{date}'}. The extension is kept unless you add one.</div>
      {preview && (
        <ul className="oplist" aria-label="Preview">
          {preview.ops.map((op, i) => <li key={i}>{opLabel(op)}</li>)}
          {preview.skipped.map((s, i) => <li key={`s${i}`} className="muted">{s.path.join('/')} — {s.reason}</li>)}
          {files.length > 8 && <li className="muted">…and {files.length - 8} more</li>}
        </ul>
      )}
    </Dialog>
  );
}

function FolderPicker({ fs, onPick, onClose }: { fs: FsLike; onPick(p: string[]): void; onClose(): void }) {
  const [at, setAt] = useState<string[]>([]);
  const [folders, setFolders] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    setFolders(null);
    fs.list(at).then((l) => alive && setFolders(l.filter((e) => e.kind === 'folder' && e.name !== TRASH_DIR).map((e) => e.name).sort()), () => alive && setFolders([]));
    return () => { alive = false; };
  }, [fs, at]);
  return (
    <Dialog title="Move to…" onClose={onClose}>
      <div className="crumbs">
        <button onClick={() => setAt([])}>Library</button>
        {at.map((seg, i) => <span key={i}>/ <button onClick={() => setAt(at.slice(0, i + 1))}>{seg}</button></span>)}
      </div>
      <ul className="oplist" aria-label="Destination folders">
        {folders === null ? <li className="muted">Loading…</li> : folders.length === 0 ? <li className="muted">No subfolders</li>
          : folders.map((f) => <li key={f}><button className="ghost" onClick={() => setAt([...at, f])}>{f}</button></li>)}
      </ul>
      <div className="row"><span className="grow" /><button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => onPick(at)}>Move here</button></div>
    </Dialog>
  );
}

const SORT_RULES: [SortRule, string][] = [['by-type', 'By type (images / gifs / videos)'], ['by-board-thread', 'By board and thread'], ['by-month', 'By month']];

function SortPrompt({ count, onSubmit, onClose }: { count: number; onSubmit(r: SortRule): void; onClose(): void }) {
  const [rule, setRule] = useState<SortRule>('by-type');
  return (
    <Dialog title={`Sort ${count} file${count === 1 ? '' : 's'} into folders`} onClose={onClose}>
      <div role="radiogroup" aria-label="Sort rule">
        {SORT_RULES.map(([r, label]) => <label key={r} className="row"><input type="radio" checked={rule === r} onChange={() => setRule(r)} /> {label}</label>)}
      </div>
      <div className="muted">Folders are created at the top of the library.</div>
      <div className="row"><span className="grow" /><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => onSubmit(rule)}>Continue</button></div>
    </Dialog>
  );
}

interface Props {
  path: string[];
  selection: LibraryEntry[];
  folderFiles: LibraryEntry[]; // every file in the current folder (Sort uses these when nothing is selected)
  fs: FsLike;
  canUndo: boolean;
  onRequest(r: PlanRequest): void;
  onUndo(): void;
  onEmptyTrash(): void;
  onReadOnly(): void;
  withStats(files: LibraryEntry[]): Promise<LibraryEntry[]>;
}

/** Organize actions. Each one only builds a PlanRequest; nothing touches disk until the preview dialog is confirmed. */
export function LibraryOrganizeBar({ path, selection, folderFiles, fs, canUndo, onRequest, onUndo, onEmptyTrash, onReadOnly, withStats }: Props) {
  const [dialog, setDialog] = useState<null | 'new' | 'rename' | 'bulk' | 'sort' | 'move'>(null);
  const files = selection.filter((e) => e.kind === 'file');
  const hasFolders = selection.length > files.length;
  const inTrash = path[0] === TRASH_DIR;
  const restorable = files.filter((f) => f.path[0] === TRASH_DIR && f.path.length >= 3);
  const filesOnly = hasFolders ? 'Folders cannot be moved, renamed or trashed here yet. Open the folder and select its files instead.' : undefined;
  const none = files.length === 0 || hasFolders;
  const existing = existsIn(fs);
  const close = () => setDialog(null);
  const request = (r: PlanRequest) => { setDialog(null); onRequest(r); };
  const sortTargets = files.length ? files : folderFiles;

  return (
    <div className="toolbar">
      <div className="row" role="toolbar" aria-label="Organize">
        <button disabled={inTrash} onClick={() => setDialog('new')}>New folder</button>
        <button disabled={none || inTrash} title={filesOnly} onClick={() => setDialog('move')}>Move to…</button>
        <button disabled={files.length !== 1 || hasFolders || inTrash} title={filesOnly} onClick={() => setDialog('rename')}>Rename</button>
        <button disabled={none || inTrash} title={filesOnly} onClick={() => setDialog('bulk')}>Bulk rename</button>
        <button disabled={hasFolders || inTrash || sortTargets.length === 0} title={filesOnly ?? 'Sorts the selected files, or every file in this folder when nothing is selected'}
          onClick={() => setDialog('sort')}>Sort into folders</button>
        <button disabled={none || inTrash} title={filesOnly} className="danger"
          onClick={() => request({ title: `Move ${files.length} file${files.length === 1 ? '' : 's'} to trash`, plan: () => planTrash(files, existing) })}>Move to trash</button>
        {inTrash && <button disabled={restorable.length === 0 || hasFolders} onClick={() => request({
          title: `Restore ${restorable.length} file${restorable.length === 1 ? '' : 's'}`, collisionChoice: true,
          plan: async (c) => {
            // Trash paths are [TRASH_DIR, date, ...originalPath]; restoring is a move back to the original folder.
            // One planMove per destination folder, so files restoring to the same place dedupe against each other too.
            const groups = new Map<string, LibraryEntry[]>();
            for (const f of restorable) {
              const k = f.path.slice(2, -1).join('/');
              groups.set(k, [...(groups.get(k) ?? []), f]);
            }
            const out: PlanResult = { ops: [], skipped: [], warnings: [] };
            for (const group of groups.values()) {
              const r = await planMove(group, group[0].path.slice(2, -1), c, existing);
              out.ops.push(...r.ops.map((op): Op => ({ ...op, kind: 'restore' })));
              out.skipped.push(...r.skipped);
            }
            return out;
          },
        })}>Restore</button>}
        {inTrash && <button className="danger" onClick={onEmptyTrash}>Empty trash</button>}
        <button disabled={!canUndo} onClick={onUndo}>Undo last</button>
        <span className="grow" />
        <button className="ghost" onClick={onReadOnly} title="Hides organize controls. Chrome keeps the write permission until you revoke it in site settings.">Back to read-only</button>
      </div>
      {filesOnly && <div className="muted">{filesOnly}</div>}

      {dialog === 'new' && <NamePrompt title="New folder" initial="" onClose={close} onSubmit={(name) => request({
        title: `Create folder "${name}"`,
        plan: async () => {
          const to = [...path, name];
          if (name === TRASH_DIR) return { ops: [], skipped: [{ path: to, reason: 'reserved name (used for the trash)' }], warnings: [] };
          return (await existing(to))
            ? { ops: [], skipped: [{ path: to, reason: 'already exists' }], warnings: [] }
            : { ops: [{ kind: 'mkdir', to }], skipped: [], warnings: [] };
        },
      })} />}
      {dialog === 'rename' && files[0] && <NamePrompt title={`Rename ${files[0].name}`} initial={files[0].name} onClose={close}
        onSubmit={(name) => request({ title: `Rename ${files[0].name}`, collisionChoice: true, plan: (c) => planRename(files[0], name, c, existing) })} />}
      {dialog === 'bulk' && <BulkRenamePrompt files={files} fs={fs} onClose={close}
        onSubmit={(tpl) => request({ title: `Bulk rename ${files.length} files`, collisionChoice: true, plan: (c) => planBulkRename(files, tpl, c, existing) })} />}
      {dialog === 'sort' && <SortPrompt count={sortTargets.length} onClose={close}
        onSubmit={(rule) => request({ title: 'Sort into folders', plan: async () => planSort(rule === 'by-month' ? await withStats(sortTargets) : sortTargets, rule, existing) })} />}
      {dialog === 'move' && <FolderPicker fs={fs} onClose={close} onPick={(dest) => request(movePlanRequest(files, dest, fs))} />}
    </div>
  );
}
