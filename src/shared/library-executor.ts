/**
 * Executes a plan of `Op`s (Task 8) against `FsLike` (Task 7), journaling every step so the
 * run can be undone. Never decides what to do — only how to do it safely.
 */
import type { Op, OpKind } from './library-ops';
import type { FsLike } from './library-fs';

export interface JournalEntry {
  id: string;
  at: number;
  ops: Array<{ kind: OpKind; from?: string[]; to?: string[]; done: boolean }>;
}

// chrome.storage.local, last 20, paths only
export interface JournalStore {
  load(): Promise<JournalEntry[]>;
  save(j: JournalEntry[]): Promise<void>;
}

const JOURNAL_CAP = 20;

/** mkdir has no `from`; every other kind is a move to `to`, just with different semantics
 *  upstream (rename/trash/restore are all moves — see Task 8's planner output). */
function requiresMove(kind: OpKind): boolean {
  return kind === 'move' || kind === 'rename' || kind === 'trash' || kind === 'restore';
}

async function runOp(op: Op, fs: FsLike): Promise<void> {
  if (op.kind === 'mkdir') {
    if (!op.to) throw new Error('mkdir op missing `to`');
    await fs.mkdirp(op.to);
    return;
  }
  if (requiresMove(op.kind)) {
    if (!op.from || !op.to) throw new Error(`${op.kind} op missing from/to`);
    await fs.move(op.from, op.to);
    return;
  }
  throw new Error(`unknown op kind: ${op.kind}`);
}

export async function executePlan(
  plan: Op[],
  fs: FsLike,
  journal: JournalStore,
  o: { signal: AbortSignal; onProgress(done: number, total: number): void },
): Promise<{ done: number; failed: { op: Op; error: string }[] }> {
  const entry: JournalEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    at: Date.now(),
    ops: plan.map((op) => ({ kind: op.kind, from: op.from, to: op.to, done: false })),
  };

  // Journal the intended ops before running any.
  const existing = await journal.load();
  await journal.save([...existing, entry].slice(-JOURNAL_CAP));

  let done = 0;
  const failed: { op: Op; error: string }[] = [];

  for (let i = 0; i < plan.length; i += 1) {
    if (o.signal.aborted) break;
    const op = plan[i];
    try {
      await runOp(op, fs);
      entry.ops[i].done = true;
      done += 1;
    } catch (err) {
      failed.push({ op, error: err instanceof Error ? err.message : String(err) });
    }
    o.onProgress(done, plan.length);
    await persistEntry(journal, entry);
  }

  return { done, failed };
}

/** Re-save the journal with this entry's current state (it's already the last one saved). */
async function persistEntry(journal: JournalStore, entry: JournalEntry): Promise<void> {
  const all = await journal.load();
  const idx = all.findIndex((e) => e.id === entry.id);
  if (idx === -1) return;
  all[idx] = entry;
  await journal.save(all);
}

/** Find a destination path that's free, suffixing "-2", "-3", ... like the planner does. */
async function freePath(fs: FsLike, path: string[]): Promise<string[]> {
  if (!(await fs.exists(path))) return path;
  const dir = path.slice(0, -1);
  const name = path[path.length - 1];
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  for (let n = 2; ; n += 1) {
    const candidate = [...dir, ext ? `${base}-${n}.${ext}` : `${base}-${n}`];
    if (!(await fs.exists(candidate))) return candidate;
  }
}

export async function undoLast(fs: FsLike, journal: JournalStore): Promise<{ undone: number; failed: number }> {
  const all = await journal.load();
  const entry = all[all.length - 1];
  if (!entry) return { undone: 0, failed: 0 };

  let undone = 0;
  let failed = 0;

  // Reverse completed ops in reverse order. `op.done` doubles as "still needs undoing": once an
  // op is successfully reversed here, we flip it back to false so a retried/second undoLast call
  // (after a partial failure) doesn't re-attempt it.
  for (let i = entry.ops.length - 1; i >= 0; i -= 1) {
    const op = entry.ops[i];
    if (!op.done) continue;
    try {
      if (op.kind === 'mkdir') {
        // Nothing meaningful to undo for a bare mkdir (we never remove folders).
        op.done = false;
        undone += 1;
        continue;
      }
      if (!op.from || !op.to) throw new Error(`${op.kind} op missing from/to`);
      if ((await fs.exists(op.to)) === null) {
        // The op's target is truly gone (e.g. permanently deleted by "empty trash" after this
        // move was journaled) — there's nothing left to reverse. Retrying would fail forever and
        // block every earlier, still-reversible entry behind it, so drop it instead: clear `done`
        // (it's no longer pending) without counting it as a normal undo or a retryable failure.
        op.done = false;
        continue;
      }
      const restoreTo = await freePath(fs, op.from);
      await fs.move(op.to, restoreTo);
      op.done = false;
      undone += 1;
    } catch {
      // Leave op.done === true: it still needs undoing, so it's retried on the next call and
      // isn't silently lost.
      failed += 1;
    }
  }

  // Only drop the journal entry once every op in it has been fully reversed. On a partial
  // failure, keep the entry (with its updated done flags) so nothing is lost and a future
  // undoLast or diagnostic can tell exactly which ops still need attention.
  if (failed === 0) {
    await journal.save(all.slice(0, -1));
  } else {
    all[all.length - 1] = entry;
    await journal.save(all);
  }
  return { undone, failed };
}
