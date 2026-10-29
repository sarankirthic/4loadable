import test from 'node:test';
import assert from 'node:assert/strict';
import { executePlan, undoLast } from '../src/shared/library-executor.ts';
import type { JournalEntry, JournalStore } from '../src/shared/library-executor.ts';
import type { Op } from '../src/shared/library-ops.ts';
import { createFsLike } from '../src/shared/library-fs.ts';
import { makeFakeDir, makeFakeFile } from './fake-fs.ts';

function fakeJournal(initial: JournalEntry[] = []): JournalStore {
  let entries = initial;
  return {
    async load() {
      return entries;
    },
    async save(j) {
      entries = j;
    },
  };
}

function noopProgress() {}

test('executePlan: successful native move, journaled before run and marked done', async () => {
  const root = makeFakeDir();
  root.setChild('src.png', makeFakeFile('src.png', { content: new Uint8Array([1, 2, 3]), supportsMove: true }));
  const fs = createFsLike(root);
  const journal = fakeJournal();

  const ops: Op[] = [{ kind: 'move', from: ['src.png'], to: ['dest', 'src.png'] }];
  const result = await executePlan(ops, fs, journal, { signal: new AbortController().signal, onProgress: noopProgress });

  assert.equal(result.done, 1);
  assert.deepEqual(result.failed, []);
  assert.equal(await fs.exists(['dest', 'src.png']), 'file');
  assert.equal(await fs.exists(['src.png']), null);

  const saved = await journal.load();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].ops[0].done, true);
});

test('executePlan: copy fallback (no native move) verified before delete', async () => {
  const root = makeFakeDir();
  root.setChild('src.png', makeFakeFile('src.png', { content: new Uint8Array([1, 2, 3]) })); // no supportsMove
  const fs = createFsLike(root);
  const journal = fakeJournal();

  const ops: Op[] = [{ kind: 'move', from: ['src.png'], to: ['dest.png'] }];
  const result = await executePlan(ops, fs, journal, { signal: new AbortController().signal, onProgress: noopProgress });

  assert.equal(result.done, 1);
  assert.equal(await fs.exists(['dest.png']), 'file');
  assert.equal(await fs.exists(['src.png']), null);
});

test('executePlan: size mismatch on fallback keeps source, removes partial dest, records failure', async () => {
  const root = makeFakeDir();
  root.setChild('src.png', makeFakeFile('src.png', { content: new Uint8Array([1, 2, 3]), sizeOverride: 999 }));
  const fs = createFsLike(root);
  const journal = fakeJournal();

  const ops: Op[] = [{ kind: 'move', from: ['src.png'], to: ['dest.png'] }];
  const result = await executePlan(ops, fs, journal, { signal: new AbortController().signal, onProgress: noopProgress });

  assert.equal(result.done, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(await fs.exists(['src.png']), 'file');
  assert.equal(await fs.exists(['dest.png']), null);

  const saved = await journal.load();
  assert.equal(saved[0].ops[0].done, false);
});

test('executePlan: copy error keeps source intact and records failure', async () => {
  const root = makeFakeDir();
  const boom = new Error('read failed');
  root.setChild('src.png', makeFakeFile('src.png', { getFileError: boom }));
  const fs = createFsLike(root);
  const journal = fakeJournal();

  const ops: Op[] = [{ kind: 'move', from: ['src.png'], to: ['dest.png'] }];
  const result = await executePlan(ops, fs, journal, { signal: new AbortController().signal, onProgress: noopProgress });

  assert.equal(result.done, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(await fs.exists(['src.png']), 'file');
  assert.equal(await fs.exists(['dest.png']), null);
});

test('executePlan: abort midway leaves earlier moves done and later ones not attempted', async () => {
  const root = makeFakeDir();
  root.setChild('a.png', makeFakeFile('a.png', { content: new Uint8Array([1]), supportsMove: true }));
  root.setChild('b.png', makeFakeFile('b.png', { content: new Uint8Array([2]), supportsMove: true }));
  const fs = createFsLike(root);
  const journal = fakeJournal();
  const ac = new AbortController();

  const ops: Op[] = [
    { kind: 'move', from: ['a.png'], to: ['out', 'a.png'] },
    { kind: 'move', from: ['b.png'], to: ['out', 'b.png'] },
  ];
  const result = await executePlan(ops, fs, journal, {
    signal: ac.signal,
    onProgress: (done) => {
      if (done === 1) ac.abort();
    },
  });

  assert.equal(result.done, 1);
  assert.equal(await fs.exists(['out', 'a.png']), 'file');
  assert.equal(await fs.exists(['b.png']), 'file'); // never attempted
  assert.equal(await fs.exists(['out', 'b.png']), null);

  const saved = await journal.load();
  assert.equal(saved[0].ops[0].done, true);
  assert.equal(saved[0].ops[1].done, false);
});

test('undoLast restores originals in reverse order', async () => {
  const root = makeFakeDir();
  root.setChild('a.png', makeFakeFile('a.png', { content: new Uint8Array([1]), supportsMove: true }));
  const fs = createFsLike(root);
  const journal = fakeJournal();

  const ops: Op[] = [{ kind: 'move', from: ['a.png'], to: ['out', 'a.png'] }];
  await executePlan(ops, fs, journal, { signal: new AbortController().signal, onProgress: noopProgress });

  const undoResult = await undoLast(fs, journal);
  assert.equal(undoResult.undone, 1);
  assert.equal(undoResult.failed, 0);
  assert.equal(await fs.exists(['a.png']), 'file');
  assert.equal(await fs.exists(['out', 'a.png']), null);

  // journal entry consumed
  const saved = await journal.load();
  assert.equal(saved.length, 0);
});

test('undo into an occupied original path uses a suffixed name and reports it', async () => {
  const root = makeFakeDir();
  root.setChild('a.png', makeFakeFile('a.png', { content: new Uint8Array([1]), supportsMove: true }));
  const fs = createFsLike(root);
  const journal = fakeJournal();

  const ops: Op[] = [{ kind: 'move', from: ['a.png'], to: ['out', 'a.png'] }];
  await executePlan(ops, fs, journal, { signal: new AbortController().signal, onProgress: noopProgress });

  // Something else now occupies the original path.
  await fs.mkdirp([]);
  root.setChild('a.png', makeFakeFile('a.png', { content: new Uint8Array([9]) }));

  const undoResult = await undoLast(fs, journal);
  assert.equal(undoResult.undone, 1);
  assert.equal(undoResult.failed, 0);
  // original occupant still there
  assert.equal(await fs.size(['a.png']), 1);
  // restored file landed at a suffixed name
  assert.equal(await fs.exists(['a-2.png']), 'file');
});

test('journal is capped at 20 entries', async () => {
  const root = makeFakeDir();
  const journal = fakeJournal(
    Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, at: i, ops: [] })),
  );
  root.setChild('x.png', makeFakeFile('x.png', { content: new Uint8Array([1]), supportsMove: true }));
  const fs = createFsLike(root);

  const ops: Op[] = [{ kind: 'move', from: ['x.png'], to: ['y.png'] }];
  await executePlan(ops, fs, journal, { signal: new AbortController().signal, onProgress: noopProgress });

  const saved = await journal.load();
  assert.equal(saved.length, 20);
  assert.equal(saved[saved.length - 1].ops[0].to?.[0], 'y.png');
  assert.ok(!saved.some((e) => e.id === 'old-0')); // oldest dropped
});

test('mkdir op creates the directory', async () => {
  const root = makeFakeDir();
  const fs = createFsLike(root);
  const journal = fakeJournal();

  const ops: Op[] = [{ kind: 'mkdir', to: ['new', 'folder'] }];
  const result = await executePlan(ops, fs, journal, { signal: new AbortController().signal, onProgress: noopProgress });

  assert.equal(result.done, 1);
  assert.equal(await fs.exists(['new', 'folder']), 'folder');
});

test('rename and trash ops go through move logic', async () => {
  const root = makeFakeDir();
  root.setChild('old.png', makeFakeFile('old.png', { content: new Uint8Array([1]), supportsMove: true }));
  root.setChild('t.png', makeFakeFile('t.png', { content: new Uint8Array([2]), supportsMove: true }));
  const fs = createFsLike(root);
  const journal = fakeJournal();

  const ops: Op[] = [
    { kind: 'rename', from: ['old.png'], to: ['new.png'] },
    { kind: 'trash', from: ['t.png'], to: ['.4loadable-trash', '2026-10-29', 't.png'] },
  ];
  const result = await executePlan(ops, fs, journal, { signal: new AbortController().signal, onProgress: noopProgress });

  assert.equal(result.done, 2);
  assert.equal(await fs.exists(['new.png']), 'file');
  assert.equal(await fs.exists(['.4loadable-trash', '2026-10-29', 't.png']), 'file');
});

test('restore op moves from trash back to original location', async () => {
  const root = makeFakeDir();
  const fs = createFsLike(root);
  await fs.mkdirp(['.4loadable-trash', '2026-10-29']);
  const dateFolder = root.getChild('.4loadable-trash') as ReturnType<typeof makeFakeDir>;
  (dateFolder.getChild('2026-10-29') as ReturnType<typeof makeFakeDir>).setChild(
    'r.png',
    makeFakeFile('r.png', { content: new Uint8Array([1]), supportsMove: true }),
  );

  const journal = fakeJournal();
  const ops: Op[] = [{ kind: 'restore', from: ['.4loadable-trash', '2026-10-29', 'r.png'], to: ['r.png'] }];
  const result = await executePlan(ops, fs, journal, { signal: new AbortController().signal, onProgress: noopProgress });

  assert.equal(result.done, 1);
  assert.equal(await fs.exists(['r.png']), 'file');
});
