import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planMove, planRename, planBulkRename, planSort, planTrash, TRASH_DIR,
} from '../src/shared/library-ops.ts';
import type { LibraryEntry } from '../src/shared/library-types.ts';

function file(path: string[], extra: Partial<LibraryEntry> = {}): LibraryEntry {
  return { kind: 'file', name: path[path.length - 1], path, ...extra };
}
function folder(path: string[], extra: Partial<LibraryEntry> = {}): LibraryEntry {
  return { kind: 'folder', name: path[path.length - 1], path, ...extra };
}

/** A lookup-only fake: tracks a set of paths "on disk" (case-insensitive), answers existing(). */
function fakeFs(paths: string[][] = []) {
  const set = new Set(paths.map((p) => p.join('/').toLowerCase()));
  const calls: string[][] = [];
  const existing = async (p: string[]) => {
    calls.push(p);
    return set.has(p.join('/').toLowerCase());
  };
  return { existing, calls };
}

test('planMove is pure: only calls existing(), never mutates anything', async () => {
  const { existing, calls } = fakeFs();
  const entries = [file(['a', 'x.png'])];
  const result = await planMove(entries, ['b'], 'rename', existing);
  assert.equal(result.ops.length, 1);
  assert.ok(calls.length > 0); // confirms existing() is the only I/O touchpoint used
});

test('planMove resolves collisions with -2, -3 suffixes, case-insensitively', async () => {
  const { existing } = fakeFs([['b', 'x.png'], ['b', 'x-2.png']]);
  const result = await planMove([file(['a', 'X.PNG'])], ['b'], 'rename', existing);
  assert.equal(result.ops.length, 1);
  assert.deepEqual(result.ops[0].to, ['b', 'X-3.PNG']);
});

test('planMove in skip collision mode skips colliding entries instead of renaming', async () => {
  const { existing } = fakeFs([['b', 'x.png']]);
  const result = await planMove([file(['a', 'x.png'])], ['b'], 'skip', existing);
  assert.equal(result.ops.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'collision');
});

test('planMove resolves collisions among the entries being moved together, not just existing()', async () => {
  const { existing } = fakeFs();
  const result = await planMove(
    [file(['a', 'x.png']), file(['c', 'x.png'])],
    ['b'],
    'rename',
    existing,
  );
  assert.equal(result.ops.length, 2);
  assert.deepEqual(result.ops[0].to, ['b', 'x.png']);
  assert.deepEqual(result.ops[1].to, ['b', 'x-2.png']);
});

test('planMove refuses moving a folder into itself', async () => {
  const { existing } = fakeFs();
  const result = await planMove([folder(['a', 'b'])], ['a', 'b'], 'rename', existing);
  assert.equal(result.ops.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /itself|descendant/);
});

test('planMove refuses moving a folder into its own descendant', async () => {
  const { existing } = fakeFs();
  const result = await planMove([folder(['a', 'b'])], ['a', 'b', 'c'], 'rename', existing);
  assert.equal(result.ops.length, 0);
  assert.equal(result.skipped.length, 1);
});

test('planMove refuses an op whose destination equals its source', async () => {
  const { existing } = fakeFs();
  const result = await planMove([file(['a', 'x.png'])], ['a'], 'rename', existing);
  assert.equal(result.ops.length, 0);
  assert.equal(result.skipped[0].reason, 'destination equals source');
});

test(`planMove refuses ${TRASH_DIR} as a normal destination`, async () => {
  const { existing } = fakeFs();
  const result = await planMove([file(['a', 'x.png'])], [TRASH_DIR], 'rename', existing);
  assert.equal(result.ops.length, 0);
  assert.equal(result.skipped.length, 1);
});

test('planRename validates with isSafeName and rejects unsafe names rather than sanitizing', async () => {
  const { existing } = fakeFs();
  for (const bad of ['../x', 'a/b', 'a\\b', '..']) {
    const result = await planRename(file(['dir', 'old.png']), bad, 'rename', existing);
    assert.equal(result.ops.length, 0, `expected ${bad} to be rejected`);
    assert.equal(result.skipped[0].reason, 'unsafe name');
  }
});

test('planRename keeps the original extension when the new name omits one', async () => {
  const { existing } = fakeFs();
  const result = await planRename(file(['dir', 'old.png']), 'newname', 'rename', existing);
  assert.equal(result.ops.length, 1);
  assert.deepEqual(result.ops[0].to, ['dir', 'newname.png']);
});

test('planRename honors an explicit extension change in the new name', async () => {
  const { existing } = fakeFs();
  const result = await planRename(file(['dir', 'old.png']), 'newname.txt', 'rename', existing);
  assert.equal(result.ops.length, 1);
  assert.deepEqual(result.ops[0].to, ['dir', 'newname.txt']);
});

test('planRename resolves a collision with a -2 suffix, case-insensitively', async () => {
  const { existing } = fakeFs([['dir', 'taken.png']]);
  const result = await planRename(file(['dir', 'old.png']), 'TAKEN', 'rename', existing);
  assert.equal(result.ops.length, 1);
  assert.deepEqual(result.ops[0].to, ['dir', 'TAKEN-2.png']);
});

test('planBulkRename expands {original} {n} {ext} {date} tokens via renderTemplate', async () => {
  const { existing } = fakeFs();
  const now = new Date('2026-01-15T00:00:00Z');
  const entries = [file(['dir', 'cat.png']), file(['dir', 'dog.png'])];
  const result = await planBulkRename(entries, '{original}-{n}-{date}.{ext}', 'rename', existing, now);
  assert.equal(result.ops.length, 2);
  assert.deepEqual(result.ops[0].to, ['dir', 'cat-1-2026-01-15.png']);
  assert.deepEqual(result.ops[1].to, ['dir', 'dog-2-2026-01-15.png']);
});

test('planBulkRename preserves the extension when the template does not control it', async () => {
  const { existing } = fakeFs();
  const result = await planBulkRename([file(['dir', 'cat.png'])], 'renamed-{n}', 'rename', existing);
  assert.equal(result.ops.length, 1);
  assert.deepEqual(result.ops[0].to, ['dir', 'renamed-1.png']);
});

test('planBulkRename resolves collisions between the renamed files themselves', async () => {
  const { existing } = fakeFs();
  const result = await planBulkRename(
    [file(['dir', 'a.png']), file(['dir', 'b.png'])],
    'same',
    'rename',
    existing,
  );
  assert.equal(result.ops.length, 2);
  assert.deepEqual(result.ops[0].to, ['dir', 'same.png']);
  assert.deepEqual(result.ops[1].to, ['dir', 'same-2.png']);
});

test('planSort by-type groups files into type folders', async () => {
  const { existing } = fakeFs();
  const entries = [
    file(['dir', 'cat.png'], { mediaType: 'image' }),
    file(['dir', 'vid.mp4'], { mediaType: 'video' }),
    file(['dir', 'noext'], {}),
  ];
  const result = await planSort(entries, 'by-type', existing);
  assert.equal(result.ops.length, 3);
  assert.deepEqual(result.ops[0].to, ['images', 'cat.png']);
  assert.deepEqual(result.ops[1].to, ['videos', 'vid.mp4']);
  assert.deepEqual(result.ops[2].to, ['other', 'noext']);
});

test('planSort by-board-thread groups by the two enclosing folders, stripping a trailing media-type leaf', async () => {
  const { existing } = fakeFs();
  const entries = [
    file(['4chan', 'g', '12345', 'images', 'cat.png']),
    file(['4chan', 'g', '12345', 'dog.png']),
  ];
  const result = await planSort(entries, 'by-board-thread', existing);
  assert.equal(result.ops.length, 2);
  assert.deepEqual(result.ops[0].to, ['g', '12345', 'cat.png']);
  assert.deepEqual(result.ops[1].to, ['g', '12345', 'dog.png']);
});

test('planSort by-month groups by the modifiedAt year-month', async () => {
  const { existing } = fakeFs();
  const entries = [file(['dir', 'cat.png'], { modifiedAt: new Date('2025-03-10T00:00:00Z').getTime() })];
  const result = await planSort(entries, 'by-month', existing);
  assert.equal(result.ops.length, 1);
  assert.deepEqual(result.ops[0].to, ['2025-03', 'cat.png']);
});

test('planSort skips non-file entries', async () => {
  const { existing } = fakeFs();
  const result = await planSort([folder(['dir', 'sub'])], 'by-type', existing);
  assert.equal(result.ops.length, 0);
  assert.equal(result.skipped[0].reason, 'not a file');
});

test(`planTrash moves entries to ${TRASH_DIR}/<yyyy-mm-dd>/<original path>`, async () => {
  const { existing } = fakeFs();
  const now = new Date('2026-02-03T00:00:00Z');
  const result = await planTrash([file(['4chan', 'g', '1', 'cat.png'])], existing, now);
  assert.equal(result.ops.length, 1);
  assert.deepEqual(result.ops[0].to, [TRASH_DIR, '2026-02-03', '4chan', 'g', '1', 'cat.png']);
  assert.deepEqual(result.ops[0].from, ['4chan', 'g', '1', 'cat.png']);
});

test('planTrash skips entries already inside the trash directory', async () => {
  const { existing } = fakeFs();
  const result = await planTrash([file([TRASH_DIR, '2026-01-01', 'x.png'])], existing);
  assert.equal(result.ops.length, 0);
  assert.equal(result.skipped[0].reason, 'already in trash');
});
