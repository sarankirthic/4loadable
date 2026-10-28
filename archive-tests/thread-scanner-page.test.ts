import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectPage } from '../src/content/page-detector.ts';
import { itemsFromThreadJson, listBoardThreads, scanThreads, validBoard, validThreadId, type ThreadFetchDeps } from '../src/background/thread-scanner.ts';

const loc = (u: string) => { const x = new URL(u); return { hostname: x.hostname, pathname: x.pathname, href: x.href }; };

test('page detection: threads, boards, catalogs, unsupported', () => {
  assert.deepEqual(pick(detectPage(loc('https://boards.4chan.org/g/thread/12345'))), ['thread', 'g', '12345']);
  assert.deepEqual(pick(detectPage(loc('https://boards.4channel.org/a/thread/987/some-slug'))), ['thread', 'a', '987']);
  assert.deepEqual(pick(detectPage(loc('https://boards.4chan.org/g/'))), ['board', 'g', undefined]);
  assert.deepEqual(pick(detectPage(loc('https://boards.4chan.org/g/2'))), ['board', 'g', undefined]);
  assert.deepEqual(pick(detectPage(loc('https://boards.4chan.org/g/catalog'))), ['catalog', 'g', undefined]);
  for (const u of ['https://boards.4chan.org/', 'https://boards.4chan.org/g/archive', 'https://www.4chan.org/rules', 'https://example.com/g/thread/1'])
    assert.equal(detectPage(loc(u)).kind, 'unsupported', u);
});
const pick = (p: any) => [p.kind, p.board, p.threadId];

test('API thread JSON -> media items (skips text-only, deleted)', () => {
  const json = JSON.parse(readFileSync(new URL('./fixtures/thread.json', import.meta.url), 'utf8'));
  const items = itemsFromThreadJson('g', '1000', json);
  assert.deepEqual(items.map((i) => [i.type, i.postNo, i.ext]), [['image', '1000', 'png'], ['video', '1001', 'webm'], ['gif', '1004', 'gif']]);
  assert.equal(items[1].size, 2222222);
});

test('board/thread validation', () => {
  assert.ok(validBoard('g') && validBoard('wsg') && !validBoard('../x') && !validBoard('') && !validBoard('a/b'));
  assert.ok(validThreadId('12345') && !validThreadId('12a') && !validThreadId('') && !validThreadId('1'.repeat(20)));
});

function fakeDeps(responses: Record<string, { status: number; json?: any } | Error>) {
  const calls: string[] = []; const sleeps: number[] = [];
  const deps: ThreadFetchDeps = {
    async fetchJson(url) { calls.push(url); const r = responses[url]; if (r instanceof Error) throw r; return r ?? { status: 404 }; },
    async sleep(ms, signal) { sleeps.push(ms); if (signal.aborted) throw new Error('aborted'); },
  };
  return { deps, calls, sleeps };
}

test('thread scan: sequential, throttled >=1s, reports 404 and network errors, never touches other threads', async () => {
  const json = JSON.parse(readFileSync(new URL('./fixtures/thread.json', import.meta.url), 'utf8'));
  const { deps, calls, sleeps } = fakeDeps({
    'https://a.4cdn.org/g/thread/1.json': { status: 200, json },
    'https://a.4cdn.org/g/thread/2.json': { status: 404 },
    'https://a.4cdn.org/g/thread/3.json': new Error('offline'),
  });
  const errors: string[] = []; let total = 0; const progress: number[] = [];
  await scanThreads('g', ['1', '2', '3', '3', 'bad/id'], deps, {
    onItems: (items, done) => { total += items.length; progress.push(done); }, onError: (m) => errors.push(m),
  }, new AbortController().signal);
  assert.equal(calls.length, 3);
  assert.equal(total, 3);
  assert.ok(sleeps.length === 2 && sleeps.every((s) => s >= 1000));
  assert.match(errors[0], /Thread 2 is gone/); assert.match(errors[1], /network error/);
  assert.equal(progress.at(-1), 3);
});

test('thread scan can be cancelled', async () => {
  const ac = new AbortController();
  const { deps, calls } = fakeDeps({ 'https://a.4cdn.org/g/thread/1.json': { status: 200, json: { posts: [] } } });
  deps.sleep = async () => { ac.abort(); throw new Error('aborted'); };
  await scanThreads('g', ['1', '2', '3'], deps, { onItems() {}, onError() {} }, ac.signal);
  assert.equal(calls.length, 1);
});

test('listBoardThreads parses threads.json and rejects bad boards', async () => {
  const { deps } = fakeDeps({ 'https://a.4cdn.org/g/threads.json': { status: 200, json: [{ page: 1, threads: [{ no: 5, replies: 2 }, { no: 6, replies: 0 }] }] } });
  assert.deepEqual((await listBoardThreads('g', deps, new AbortController().signal)).map((t) => t.id), ['5', '6']);
  await assert.rejects(listBoardThreads('../x', deps, new AbortController().signal));
  await assert.rejects(listBoardThreads('zz', deps, new AbortController().signal));
});
