/**
 * Pure planner: turns user intent (move/rename/bulk-rename/sort/trash) into a list of `Op`s.
 * Never touches the filesystem — the only I/O is through the injected `existing()` lookup.
 */
import type { LibraryEntry } from './library-types';
import { isSafeName } from './library-paths';
import { renderTemplate, splitName, typeFolder } from './filename-utils';

export type OpKind = 'mkdir' | 'move' | 'rename' | 'trash' | 'restore';
export interface Op { kind: OpKind; from?: string[]; to?: string[]; note?: string }
export type Collision = 'rename' | 'skip';
export interface PlanResult { ops: Op[]; skipped: { path: string[]; reason: string }[]; warnings: string[] }
export type ExistingFn = (p: string[]) => Promise<boolean>;

export const TRASH_DIR = '.4loadable-trash';

const touchesTrash = (path: string[]) => path.some((seg) => seg === TRASH_DIR);

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);

/** Is `path` equal to `ancestor`, or nested under it? (case-insensitive, for folder-into-itself checks) */
function isSameOrDescendant(path: string[], ancestor: string[]): boolean {
  if (path.length < ancestor.length) return false;
  return ancestor.every((seg, i) => path[i].toLowerCase() === seg.toLowerCase());
}

/**
 * Resolve a desired destination path against both files already on disk (via `existing`)
 * and paths already claimed earlier in this same plan (`locallyUsed`, lower-cased keys).
 * Returns the resolved path, or null if `collision === 'skip'` and a collision was found.
 */
async function resolveCollision(
  to: string[],
  existing: ExistingFn,
  locallyUsed: Set<string>,
  collision: Collision,
): Promise<string[] | null> {
  const dir = to.slice(0, -1);
  const { base, ext } = splitName(to[to.length - 1]);
  let candidate = to;
  let n = 1;
  for (;;) {
    const key = candidate.join('/').toLowerCase();
    const dup = locallyUsed.has(key) || (await existing(candidate));
    if (!dup) {
      locallyUsed.add(key);
      return candidate;
    }
    if (collision === 'skip') return null;
    n += 1;
    const name = ext ? `${base}-${n}.${ext}` : `${base}-${n}`;
    candidate = [...dir, name];
  }
}

/** Merge a user-supplied name with the original extension, unless the user explicitly set one. */
function withPreservedExtension(rendered: string, originalExt: string): string {
  const { base, ext } = splitName(rendered);
  if (ext) return rendered; // user's template/name explicitly controls the extension
  return originalExt ? `${base}.${originalExt}` : base;
}

export async function planMove(
  entries: LibraryEntry[],
  destFolder: string[],
  collision: Collision,
  existing: ExistingFn,
): Promise<PlanResult> {
  const ops: Op[] = [];
  const skipped: PlanResult['skipped'] = [];
  const locallyUsed = new Set<string>();

  if (touchesTrash(destFolder)) {
    return { ops: [], skipped: entries.map((e) => ({ path: e.path, reason: 'cannot move into trash directly' })), warnings: [] };
  }

  for (const entry of entries) {
    if (entry.kind === 'folder' && isSameOrDescendant(destFolder, entry.path)) {
      skipped.push({ path: entry.path, reason: 'cannot move a folder into itself or a descendant' });
      continue;
    }
    const want = [...destFolder, entry.name];
    if (samePath(want, entry.path)) {
      skipped.push({ path: entry.path, reason: 'destination equals source' });
      continue;
    }
    const resolved = await resolveCollision(want, existing, locallyUsed, collision);
    if (!resolved) {
      skipped.push({ path: entry.path, reason: 'collision' });
      continue;
    }
    ops.push({ kind: 'move', from: entry.path, to: resolved });
  }

  return { ops, skipped, warnings: [] };
}

export async function planRename(
  entry: LibraryEntry,
  newName: string,
  collision: Collision,
  existing: ExistingFn,
): Promise<PlanResult> {
  if (!isSafeName(newName)) {
    return { ops: [], skipped: [{ path: entry.path, reason: 'unsafe name' }], warnings: [] };
  }

  const originalExt = entry.kind === 'file' ? splitName(entry.name).ext : '';
  const finalName = entry.kind === 'file' ? withPreservedExtension(newName, originalExt) : newName;
  if (!isSafeName(finalName)) {
    return { ops: [], skipped: [{ path: entry.path, reason: 'unsafe name' }], warnings: [] };
  }

  const dir = entry.path.slice(0, -1);
  if (touchesTrash(dir)) {
    return { ops: [], skipped: [{ path: entry.path, reason: 'cannot rename inside trash' }], warnings: [] };
  }
  const want = [...dir, finalName];
  if (samePath(want, entry.path)) {
    return { ops: [], skipped: [{ path: entry.path, reason: 'destination equals source' }], warnings: [] };
  }

  const resolved = await resolveCollision(want, existing, new Set(), collision);
  if (!resolved) return { ops: [], skipped: [{ path: entry.path, reason: 'collision' }], warnings: [] };
  return { ops: [{ kind: 'rename', from: entry.path, to: resolved }], skipped: [], warnings: [] };
}

export async function planBulkRename(
  entries: LibraryEntry[],
  template: string,
  collision: Collision,
  existing: ExistingFn,
  now: Date = new Date(),
): Promise<PlanResult> {
  const ops: Op[] = [];
  const skipped: PlanResult['skipped'] = [];
  const locallyUsed = new Set<string>();
  const date = now.toISOString().slice(0, 10);

  let i = 0;
  for (const entry of entries) {
    i += 1;
    const { base, ext } = splitName(entry.name);
    const rendered = renderTemplate(template, { original: base, n: i, ext, date });
    const finalName = withPreservedExtension(rendered, ext);

    if (!isSafeName(finalName)) {
      skipped.push({ path: entry.path, reason: 'unsafe name' });
      continue;
    }
    const dir = entry.path.slice(0, -1);
    if (touchesTrash(dir)) {
      skipped.push({ path: entry.path, reason: 'cannot rename inside trash' });
      continue;
    }
    const want = [...dir, finalName];
    if (samePath(want, entry.path)) {
      skipped.push({ path: entry.path, reason: 'destination equals source' });
      continue;
    }
    const resolved = await resolveCollision(want, existing, locallyUsed, collision);
    if (!resolved) {
      skipped.push({ path: entry.path, reason: 'collision' });
      continue;
    }
    ops.push({ kind: 'rename', from: entry.path, to: resolved });
  }

  return { ops, skipped, warnings: [] };
}

export type SortRule = 'by-type' | 'by-board-thread' | 'by-month';

const MEDIA_LEAVES = new Set(['images', 'gifs', 'videos']);

/** The two directory segments immediately enclosing a file, after stripping a trailing images/gifs/videos leaf. */
function boardThreadFolder(entry: LibraryEntry): string[] {
  let dirs = entry.path.slice(0, -1);
  if (dirs.length && MEDIA_LEAVES.has(dirs[dirs.length - 1])) dirs = dirs.slice(0, -1);
  if (dirs.length >= 2) return dirs.slice(-2);
  if (dirs.length === 1) return ['unsorted', dirs[0]];
  return ['unsorted'];
}

function monthFolder(entry: LibraryEntry): string[] {
  if (typeof entry.modifiedAt !== 'number') return ['unknown-date'];
  const d = new Date(entry.modifiedAt);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return [`${y}-${m}`];
}

function destFolderFor(entry: LibraryEntry, rule: SortRule): string[] {
  if (rule === 'by-type') return [entry.mediaType ? typeFolder(entry.mediaType) : 'other'];
  if (rule === 'by-month') return monthFolder(entry);
  return boardThreadFolder(entry);
}

export async function planSort(files: LibraryEntry[], rule: SortRule, existing: ExistingFn): Promise<PlanResult> {
  const ops: Op[] = [];
  const skipped: PlanResult['skipped'] = [];
  const locallyUsed = new Set<string>();

  for (const entry of files) {
    if (entry.kind !== 'file') {
      skipped.push({ path: entry.path, reason: 'not a file' });
      continue;
    }
    const want = [...destFolderFor(entry, rule), entry.name];
    if (samePath(want, entry.path)) {
      skipped.push({ path: entry.path, reason: 'destination equals source' });
      continue;
    }
    const resolved = await resolveCollision(want, existing, locallyUsed, 'rename');
    if (!resolved) {
      skipped.push({ path: entry.path, reason: 'collision' });
      continue;
    }
    ops.push({ kind: 'move', from: entry.path, to: resolved });
  }

  return { ops, skipped, warnings: [] };
}

export async function planTrash(entries: LibraryEntry[], existing: ExistingFn, now: Date = new Date()): Promise<PlanResult> {
  const ops: Op[] = [];
  const skipped: PlanResult['skipped'] = [];
  const locallyUsed = new Set<string>();
  const date = now.toISOString().slice(0, 10);

  for (const entry of entries) {
    if (touchesTrash(entry.path)) {
      skipped.push({ path: entry.path, reason: 'already in trash' });
      continue;
    }
    const want = [TRASH_DIR, date, ...entry.path];
    const resolved = await resolveCollision(want, existing, locallyUsed, 'rename');
    if (!resolved) {
      skipped.push({ path: entry.path, reason: 'collision' });
      continue;
    }
    ops.push({ kind: 'trash', from: entry.path, to: resolved });
  }

  return { ops, skipped, warnings: [] };
}
