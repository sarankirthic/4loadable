import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserRecordsSource, type BrowserRecordsDeps } from '../src/shared/library-source-browser.ts';

const noopSignal = new AbortController().signal;

async function collect(it: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test('browser-records: POSIX absolute paths land under relative segments', async () => {
  const deps: BrowserRecordsDeps = {
    baseFolder: '/Users/me/Downloads/4chan-Downloads',
    search: async () => [
      { id: 1, filename: '/Users/me/Downloads/4chan-Downloads/g/1/images/a.png', exists: true, totalBytes: 123, startTime: '2024-01-01T00:00:00.000Z' },
    ],
  };
  const src = createBrowserRecordsSource(deps);
  const entries = await collect(src.list(['g', '1', 'images'], noopSignal));
  assert.equal(entries.length, 1);
  const a = entries[0] as any;
  assert.equal(a.kind, 'file');
  assert.equal(a.name, 'a.png');
  assert.deepEqual(a.path, ['g', '1', 'images', 'a.png']);
});

test('browser-records: Windows absolute paths land under the same relative segments', async () => {
  const deps: BrowserRecordsDeps = {
    baseFolder: 'C:\\Users\\me\\Downloads\\4chan-Downloads',
    search: async () => [
      { id: 2, filename: 'C:\\Users\\me\\Downloads\\4chan-Downloads\\g\\1\\images\\a.png', exists: true, totalBytes: 456 },
    ],
  };
  const src = createBrowserRecordsSource(deps);
  const entries = await collect(src.list(['g', '1', 'images'], noopSignal));
  assert.equal(entries.length, 1);
  const a = entries[0] as any;
  assert.equal(a.kind, 'file');
  assert.equal(a.name, 'a.png');
});

test('browser-records: items outside the base folder are excluded', async () => {
  const deps: BrowserRecordsDeps = {
    baseFolder: '/Users/me/Downloads/4chan-Downloads',
    search: async () => [
      { id: 1, filename: '/Users/me/Downloads/4chan-Downloads/g/1/a.png', exists: true },
      { id: 2, filename: '/Users/me/Downloads/elsewhere/b.png', exists: true },
    ],
  };
  const src = createBrowserRecordsSource(deps);
  const entries = await collect(src.list(['g', '1'], noopSignal));
  assert.equal(entries.length, 1);
  assert.equal((entries[0] as any).name, 'a.png');
});

test('browser-records: exists:false maps to missing:true', async () => {
  const deps: BrowserRecordsDeps = {
    baseFolder: '/base',
    search: async () => [{ id: 1, filename: '/base/g/a.png', exists: false }],
  };
  const src = createBrowserRecordsSource(deps);
  const entries = await collect(src.list(['g'], noopSignal));
  assert.equal((entries[0] as any).missing, true);
});

test('browser-records: canOrganize is false, thumbnail()/open() return null', async () => {
  const deps: BrowserRecordsDeps = { baseFolder: '/base', search: async () => [] };
  const src = createBrowserRecordsSource(deps);
  assert.equal(src.canOrganize, false);
  assert.equal(src.id, 'browser-records');
  const entry = { kind: 'file' as const, name: 'a.png', path: ['a.png'] };
  assert.equal(await src.thumbnail(entry), null);
  assert.equal(await src.open(entry), null);
});

test('browser-records: revealInOS calls show(id)', async () => {
  const calls: number[] = [];
  const deps: BrowserRecordsDeps = {
    baseFolder: '/base',
    search: async () => [{ id: 7, filename: '/base/g/a.png', exists: true }],
    show: async (id: number) => { calls.push(id); },
  };
  const src = createBrowserRecordsSource(deps);
  const [entry] = await collect(src.list(['g'], noopSignal));
  assert.ok(src.revealInOS);
  await src.revealInOS!(entry as any);
  assert.deepEqual(calls, [7]);
});
