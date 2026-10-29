import test from 'node:test';
import assert from 'node:assert/strict';
import { createFolderSource, type DirHandleLike, type FileHandleLike } from '../src/shared/library-source-folder.ts';

const noopSignal = new AbortController().signal;

// --- in-memory fake DirHandleLike/FileHandleLike -------------------------------------------

interface FakeFileOpts { size?: number; lastModified?: number; getFileSpy?: { calls: number } }

function makeFile(name: string, opts: FakeFileOpts = {}): FileHandleLike {
  return {
    kind: 'file',
    name,
    async getFile() {
      if (opts.getFileSpy) opts.getFileSpy.calls += 1;
      const blob = new Blob([new Uint8Array(opts.size ?? 0)]) as Blob & { name: string; lastModified: number };
      Object.defineProperty(blob, 'name', { value: name });
      Object.defineProperty(blob, 'lastModified', { value: opts.lastModified ?? 0 });
      return blob;
    },
  };
}

interface FakeDirOpts {
  /** Throw this error after yielding this many entries from entries(). */
  throwAfter?: number;
  error?: Error;
  /** Called once per entry actually produced by entries() — lets tests observe streaming. */
  onProduce?: (name: string) => void;
}

function makeDir(name: string, children: Map<string, DirHandleLike | FileHandleLike>, opts: FakeDirOpts = {}): DirHandleLike {
  return {
    kind: 'directory',
    name,
    async *entries() {
      let i = 0;
      for (const [childName, handle] of children) {
        if (opts.throwAfter !== undefined && i >= opts.throwAfter) {
          throw opts.error ?? new Error('entries() boom');
        }
        opts.onProduce?.(childName);
        yield [childName, handle] as [string, DirHandleLike | FileHandleLike];
        i++;
      }
    },
    async getDirectoryHandle(n: string) {
      const h = children.get(n);
      if (!h || h.kind !== 'directory') throw new Error(`not found: ${n}`);
      return h;
    },
    async getFileHandle(n: string) {
      const h = children.get(n);
      if (!h || h.kind !== 'file') throw new Error(`not found: ${n}`);
      return h;
    },
    async removeEntry() {},
  };
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}

async function collectUntilThrow(it: AsyncIterable<unknown>): Promise<{ out: unknown[]; error: unknown }> {
  const out: unknown[] = [];
  try {
    for await (const e of it) out.push(e);
    return { out, error: null };
  } catch (error) {
    return { out, error };
  }
}

// --- tests ----------------------------------------------------------------------------------

test('folder: nested list(["a","b"]) resolves through nested directory handles', async () => {
  const bDir = makeDir('b', new Map<string, DirHandleLike | FileHandleLike>([['leaf.png', makeFile('leaf.png')]]));
  const aDir = makeDir('a', new Map<string, DirHandleLike | FileHandleLike>([['b', bDir]]));
  const root = makeDir('root', new Map<string, DirHandleLike | FileHandleLike>([['a', aDir]]));
  const src = createFolderSource(root);

  const entries = (await collect(src.list(['a', 'b'], noopSignal))) as any[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'file');
  assert.equal(entries[0].name, 'leaf.png');
  assert.deepEqual(entries[0].path, ['a', 'b', 'leaf.png']);
});

test('folder: unsafe names ("..", "a/b") are silently skipped', async () => {
  const children = new Map<string, DirHandleLike | FileHandleLike>([
    ['good.png', makeFile('good.png')],
    ['..', makeFile('..')],
    ['a/b', makeFile('a/b')],
  ]);
  const root = makeDir('root', children);
  const src = createFolderSource(root);

  const entries = (await collect(src.list([], noopSignal))) as any[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'good.png');
});

test('folder: 5000 entries yield incrementally — taking 10 and breaking does not drain the rest', async () => {
  const children = new Map<string, DirHandleLike | FileHandleLike>();
  for (let i = 0; i < 5000; i++) children.set(`f${i}.png`, makeFile(`f${i}.png`));
  let produced = 0;
  const root = makeDir('root', children, { onProduce: () => { produced += 1; } });
  const src = createFolderSource(root);

  const taken: unknown[] = [];
  for await (const e of src.list([], noopSignal)) {
    taken.push(e);
    if (taken.length === 10) break;
  }
  assert.equal(taken.length, 10);
  // Streaming: breaking after 10 must not have forced the generator through all 5000.
  assert.ok(produced <= 11, `expected streaming to stop near 10, got ${produced} produced`);
});

test('folder: entries() throwing midway keeps entries already yielded and surfaces the error', async () => {
  const children = new Map<string, DirHandleLike | FileHandleLike>([
    ['a.png', makeFile('a.png')],
    ['b.png', makeFile('b.png')],
    ['c.png', makeFile('c.png')],
  ]);
  const boom = new Error('disk unplugged');
  const root = makeDir('root', children, { throwAfter: 2, error: boom });
  const src = createFolderSource(root);

  const { out, error } = await collectUntilThrow(src.list([], noopSignal));
  assert.equal(out.length, 2);
  assert.equal(error, boom);
});

test('folder: an already-aborted signal yields nothing at all', async () => {
  const children = new Map<string, DirHandleLike | FileHandleLike>([['a.png', makeFile('a.png')]]);
  const root = makeDir('root', children);
  const src = createFolderSource(root);

  const ac = new AbortController();
  ac.abort();
  const entries = await collect(src.list([], ac.signal));
  assert.equal(entries.length, 0);
});

test('folder: list() never calls getFile() on file handles', async () => {
  const spy = { calls: 0 };
  const children = new Map<string, DirHandleLike | FileHandleLike>([
    ['a.png', makeFile('a.png', { getFileSpy: spy })],
    ['b.mp4', makeFile('b.mp4', { getFileSpy: spy })],
  ]);
  const root = makeDir('root', children);
  const src = createFolderSource(root);

  await collect(src.list([], noopSignal));
  assert.equal(spy.calls, 0);
});

test('folder: list() checks abort mid-iteration, not just once up front', async () => {
  const children = new Map<string, DirHandleLike | FileHandleLike>();
  for (let i = 0; i < 20; i++) children.set(`f${i}.png`, makeFile(`f${i}.png`));
  const root = makeDir('root', children);
  const src = createFolderSource(root);

  const ac = new AbortController();
  const taken: unknown[] = [];
  for await (const e of src.list([], ac.signal)) {
    taken.push(e);
    if (taken.length === 5) ac.abort();
  }
  // Aborting after the 5th yield must stop iteration well short of all 20.
  assert.ok(taken.length < 20, `expected abort mid-iteration to cut it short, got ${taken.length}`);
});

test('folder: stat() lazily calls getFile() for size/modifiedAt', async () => {
  const spy = { calls: 0 };
  const children = new Map<string, DirHandleLike | FileHandleLike>([
    ['a.png', makeFile('a.png', { size: 1234, lastModified: 999, getFileSpy: spy })],
  ]);
  const root = makeDir('root', children);
  const src = createFolderSource(root);

  const [entry] = (await collect(src.list([], noopSignal))) as any[];
  assert.equal(spy.calls, 0);
  const result = await src.stat(entry);
  assert.equal(spy.calls, 1);
  assert.deepEqual(result, { size: 1234, modifiedAt: 999 });
});

test('folder: thumbnail() uses createImageBitmap with resizeWidth 240 for images only', async () => {
  const calls: Array<[unknown, unknown]> = [];
  (globalThis as any).createImageBitmap = async (blob: unknown, opts: unknown) => {
    calls.push([blob, opts]);
    return { width: 240 } as unknown as ImageBitmap;
  };
  try {
    const children = new Map<string, DirHandleLike | FileHandleLike>([
      ['a.png', makeFile('a.png')],
      ['b.mp4', makeFile('b.mp4')],
    ]);
    const root = makeDir('root', children);
    const src = createFolderSource(root);
    const entries = (await collect(src.list([], noopSignal))) as any[];
    const image = entries.find((e) => e.name === 'a.png');
    const video = entries.find((e) => e.name === 'b.mp4');

    const thumb = await src.thumbnail(image);
    assert.ok(thumb);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], { resizeWidth: 240 });

    const videoThumb = await src.thumbnail(video);
    assert.equal(videoThumb, null);
    assert.equal(calls.length, 1); // unchanged — never called for video
  } finally {
    delete (globalThis as any).createImageBitmap;
  }
});

test('folder: canOrganize reflects opts.writable', async () => {
  const root = makeDir('root', new Map());
  assert.equal(createFolderSource(root).canOrganize, false);
  assert.equal(createFolderSource(root, { writable: true }).canOrganize, true);
  assert.equal(createFolderSource(root).id, 'folder');
});
