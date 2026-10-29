import test from 'node:test';
import assert from 'node:assert/strict';
import { createFsLike } from '../src/shared/library-fs.ts';
import { makeFakeDir, makeFakeFile, FakeDirHandle } from './fake-fs.ts';

test('mkdirp creates nested folders and is idempotent', async () => {
  const root = makeFakeDir();
  const fs = createFsLike(root);

  await fs.mkdirp(['a', 'b', 'c']);
  assert.equal(await fs.exists(['a']), 'folder');
  assert.equal(await fs.exists(['a', 'b']), 'folder');
  assert.equal(await fs.exists(['a', 'b', 'c']), 'folder');

  // Idempotent: creating an already-existing folder is not an error.
  await assert.doesNotReject(() => fs.mkdirp(['a', 'b', 'c']));
});

test('paths with ".." throw before touching anything', async () => {
  const root = makeFakeDir();
  const fs = createFsLike(root);

  await assert.rejects(() => fs.mkdirp(['a', '..', 'b']));
  // Nothing was created — not even the safe leading segment.
  assert.equal(await fs.exists(['a']), null);

  await assert.rejects(() => fs.exists(['..']));
  await assert.rejects(() => fs.copyFile(['..'], ['x'], new AbortController().signal));
  await assert.rejects(() => fs.remove(['a', '..']));
});

test('copyFile of a throwing source removes the partial destination', async () => {
  const root = makeFakeDir();
  const boom = new Error('disk read failed');
  root.setChild('src.png', makeFakeFile('src.png', { getFileError: boom }));
  const fs = createFsLike(root);

  await assert.rejects(() => fs.copyFile(['src.png'], ['dest.png'], new AbortController().signal), boom);
  assert.equal(await fs.exists(['dest.png']), null);
});

test('copyFile aborted midway removes the partial destination', async () => {
  const root = makeFakeDir();
  const chunk1 = new Uint8Array([1, 2, 3]);
  const chunk2 = new Uint8Array([4, 5, 6]);
  root.setChild('src.bin', makeFakeFile('src.bin', { chunks: [chunk1, chunk2] }));
  const fs = createFsLike(root);

  const ac = new AbortController();
  // Abort as soon as the underlying file is read for the first time (mid-stream).
  const srcFile = root.getChild('src.bin') as ReturnType<typeof makeFakeFile>;
  const originalGetFile = srcFile.getFile.bind(srcFile);
  srcFile.getFile = async () => {
    const blob = await originalGetFile();
    ac.abort();
    return blob;
  };

  await assert.rejects(() => fs.copyFile(['src.bin'], ['dest.bin'], ac.signal));
  assert.equal(await fs.exists(['dest.bin']), null);
});

test('copyFile succeeds end-to-end when not aborted and source does not throw', async () => {
  const root = makeFakeDir();
  const content = new Uint8Array([9, 9, 9, 9]);
  root.setChild('src.bin', makeFakeFile('src.bin', { content }));
  const fs = createFsLike(root);

  await fs.copyFile(['src.bin'], ['out', 'dest.bin'], new AbortController().signal);
  assert.equal(await fs.exists(['out', 'dest.bin']), 'file');
  assert.equal(await fs.size(['out', 'dest.bin']), 4);
});

test('remove refuses folders and removes files', async () => {
  const root = makeFakeDir();
  root.setChild('folder', makeFakeDir('folder'));
  root.setChild('file.txt', makeFakeFile('file.txt', { content: new Uint8Array([1]) }));
  const fs = createFsLike(root);

  await assert.rejects(() => fs.remove(['folder']));
  assert.equal(await fs.exists(['folder']), 'folder');

  await fs.remove(['file.txt']);
  assert.equal(await fs.exists(['file.txt']), null);
});

test('exists/size/list reflect the underlying tree', async () => {
  const root = makeFakeDir();
  root.setChild('a', makeFakeDir('a'));
  (root.getChild('a') as FakeDirHandle).setChild('f.png', makeFakeFile('f.png', { content: new Uint8Array(10) }));
  const fs = createFsLike(root);

  assert.equal(await fs.exists([]), 'folder');
  assert.equal(await fs.exists(['missing']), null);
  assert.equal(await fs.exists(['a']), 'folder');
  assert.equal(await fs.exists(['a', 'f.png']), 'file');
  assert.equal(await fs.size(['a', 'f.png']), 10);

  const listing = await fs.list(['a']);
  assert.deepEqual(listing, [{ name: 'f.png', kind: 'file' }]);
});

test('move() uses native handle.move() when the handle supports it', async () => {
  const root = makeFakeDir();
  root.setChild('movable.png', makeFakeFile('movable.png', { content: new Uint8Array([1]), supportsMove: true }));
  const fs = createFsLike(root);

  await fs.move(['movable.png'], ['moved.png']);
  assert.equal(await fs.exists(['movable.png']), null);
  assert.equal(await fs.exists(['moved.png']), 'file');
});

test('move() falls back to copy-verify-delete when the handle does not support move()', async () => {
  const root = makeFakeDir();
  root.setChild('static.png', makeFakeFile('static.png', { content: new Uint8Array([1, 2, 3]) }));
  const fs = createFsLike(root);

  await fs.move(['static.png'], ['moved', 'static.png']);
  assert.equal(await fs.exists(['static.png']), null, 'source removed after verified copy');
  assert.equal(await fs.exists(['moved', 'static.png']), 'file');
  assert.equal(await fs.size(['moved', 'static.png']), 3);
});

test('move() refuses to silently overwrite an existing destination, at execution time', async () => {
  const root = makeFakeDir();
  root.setChild('src.png', makeFakeFile('src.png', { content: new Uint8Array([1, 2, 3]), supportsMove: true }));
  root.setChild('dest.png', makeFakeFile('dest.png', { content: new Uint8Array([9, 9]) }));
  const fs = createFsLike(root);

  await assert.rejects(() => fs.move(['src.png'], ['dest.png']), /Destination already exists/);
  // Destination's original content is untouched (not partially overwritten).
  assert.equal(await fs.size(['dest.png']), 2);
  // Source is untouched too.
  assert.equal(await fs.exists(['src.png']), 'file');
  assert.equal(await fs.size(['src.png']), 3);
});

test('move() fallback on size mismatch leaves the source intact, removes the partial destination, and throws', async () => {
  const root = makeFakeDir();
  // Declares a size (10) that does not match the actual bytes (3) copyFile will write —
  // simulates a corrupted/incomplete copy that the verification step must catch.
  root.setChild('bad.png', makeFakeFile('bad.png', { content: new Uint8Array([1, 2, 3]), sizeOverride: 10 }));
  const fs = createFsLike(root);

  await assert.rejects(() => fs.move(['bad.png'], ['moved.png']));
  assert.equal(await fs.exists(['bad.png']), 'file', 'source left intact');
  assert.equal(await fs.exists(['moved.png']), null, 'partial/incorrect destination removed');
});
