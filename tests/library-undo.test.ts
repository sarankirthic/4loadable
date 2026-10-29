import test from 'node:test';
import assert from 'node:assert/strict';
import { executePlan, undoLast, type JournalEntry, type JournalStore } from '../src/shared/library-executor.ts';
import { createFsLike } from '../src/shared/library-fs.ts';
import { prepareUndo } from '../src/media-manager/LibraryPanel.tsx';
import { makeFakeDir, makeFakeFile } from './fake-fs.ts';

const signal = new AbortController().signal;
const onProgress = () => {};

test('prepareUndo: a New-folder entry is dropped without a preview, and the earlier move stays undoable', async () => {
  const root = makeFakeDir();
  root.setChild('a.png', makeFakeFile('a.png', { content: new Uint8Array([1, 2]), supportsMove: true }));
  const fs = createFsLike(root);
  let entries: JournalEntry[] = [];
  const journal: JournalStore = { load: async () => entries, save: async (j) => { entries = j; } };

  await executePlan([{ kind: 'move', from: ['a.png'], to: ['b', 'a.png'] }], fs, journal, { signal, onProgress });
  await executePlan([{ kind: 'mkdir', to: ['newdir'] }], fs, journal, { signal, onProgress });
  assert.equal(entries.length, 2);

  // The mkdir-only entry has nothing to preview: it must be cleared, not left blocking.
  assert.equal(await prepareUndo(fs, journal), 'cleared');
  assert.equal(entries.length, 1);
  assert.equal(await fs.exists(['newdir']), 'folder', 'new folders are kept');

  // The earlier move is now next in line and gets a preview with its op.
  const prep = await prepareUndo(fs, journal);
  assert.ok(prep && prep !== 'cleared');
  assert.deepEqual(prep.pending.map((o) => [o.from, o.to]), [[['a.png'], ['b', 'a.png']]]);

  assert.deepEqual(await undoLast(fs, journal), { undone: 1, failed: 0 });
  assert.equal(await fs.exists(['a.png']), 'file');
  assert.equal(entries.length, 0);
});

test('prepareUndo: empty journal returns null', async () => {
  const fs = createFsLike(makeFakeDir());
  assert.equal(await prepareUndo(fs, { load: async () => [], save: async () => {} }), null);
});
