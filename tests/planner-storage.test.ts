import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestsForBatch, planDownloads, toDataUrl } from '../src/background/download-manager.ts';
import { toCsv, toJson, csvCell } from '../src/shared/manifest-export.ts';
import {
  DEFAULT_SETTINGS, HISTORY_CAP, MemoryKV, loadHistory, loadSettings, normalizeSettings, pruneHistory, saveSettings,
  StorageQuotaError, upsertHistory,
} from '../src/shared/storage.ts';
import type { HistoryRecord, MediaItem, QueueItem } from '../src/shared/types.ts';

const mk = (n: number, o: Partial<MediaItem> = {}): MediaItem => ({
  id: `g:${1700000000000 + n}`, url: `https://i.4cdn.org/g/${1700000000000 + n}.png`, board: 'g', threadId: '9', postNo: String(n),
  tim: String(1700000000000 + n), ext: 'png', type: 'image', originalName: 'image', order: n, ...o,
});
const base = { options: { ...DEFAULT_SETTINGS }, settings: { fullResOnly: true }, history: {}, batchId: 'b', date: '2026-10-25' };
const hist = (id: string, o: Partial<HistoryRecord> = {}): HistoryRecord => ({
  id, sourceUrl: 'u', originalFilename: 'a.png', mediaType: 'image', board: 'g', threadId: '9', postNo: '1', savedPath: 'p', status: 'complete', timestamp: 1, ...o,
});

test('planner gives unique paths to files sharing the same original name', () => {
  const { entries } = planDownloads({ ...base, items: [mk(1), mk(2), mk(3)] });
  assert.equal(new Set(entries.map((e) => e.path.toLowerCase())).size, 3);
  assert.ok(entries.every((e) => e.path.startsWith('4lodable/g/9/images/image')));
});

test('manifest folder is the thread folder, shared by images/gifs/videos', () => {
  const gif = mk(2, { type: 'gif', ext: 'gif', url: 'https://i.4cdn.org/g/1700000000002.gif' });
  const { entries } = planDownloads({ ...base, items: [mk(1), gif] });
  assert.deepEqual([...new Set(entries.map((e) => e.manifestDir))], ['4lodable/g/9']);
  assert.equal(planDownloads({ ...base, options: { ...base.options, writeManifest: false }, items: [mk(1)] }).entries[0].manifestDir, undefined);
});

test('planner filters by type, invalid URLs, duplicates and thumbnails', () => {
  const items = [
    mk(1), mk(1), mk(2, { type: 'gif', ext: 'gif', url: 'https://i.4cdn.org/g/1700000000002.gif' }),
    mk(3, { url: 'https://evil.example/x.png' }), mk(4, { url: 'https://i.4cdn.org/g/1700000000004s.jpg', ext: 'jpg' }),
  ];
  const { entries, skipped } = planDownloads({ ...base, items, types: { image: true, gif: false, video: true } });
  assert.deepEqual(entries.map((e) => e.id), ['g:1700000000001']);
  const reasons = skipped.map((s) => s.reason).join('|');
  assert.match(reasons, /Duplicate/); assert.match(reasons, /gif files excluded/); assert.match(reasons, /untrusted/); assert.match(reasons, /Thumbnail/);
});

test('skip mode skips known downloads unless the browser says the file is gone', () => {
  const history = { 'g:1700000000001': hist('g:1700000000001', { downloadId: 5 }), 'g:1700000000002': hist('g:1700000000002', { downloadId: 6 }) };
  const opts = { ...base.options, duplicates: 'skip' as const };
  const r = planDownloads({ ...base, options: opts, history, missingDownloadIds: new Set([6]), items: [mk(1), mk(2), mk(3)] });
  assert.deepEqual(r.entries.map((e) => e.id), ['g:1700000000002', 'g:1700000000003']);
  assert.equal(r.skipped[0].reason, 'Already downloaded');
  const rename = planDownloads({ ...base, history, items: [mk(1)] });
  assert.equal(rename.entries.length, 1, 'rename mode re-downloads with a new name');
  assert.equal(rename.entries[0].conflict, 'uniquify');
  assert.equal(planDownloads({ ...base, options: { ...base.options, duplicates: 'prompt' }, items: [mk(1)] }).entries[0].conflict, 'prompt');
});

test('planner avoids paths already taken by queued items', () => {
  const { entries } = planDownloads({ ...base, items: [mk(1)], takenPaths: new Set(['4lodable/g/9/images/image.png']) });
  assert.equal(entries[0].path, '4lodable/g/9/images/image-2.png');
});

test('manifests are produced once all items of a batch are finished', () => {
  const q = (id: string, status: QueueItem['status'], dir = 'd/g/9'): QueueItem => ({
    ...planDownloads({ ...base, items: [mk(Number(id))] }).entries[0], manifestDir: dir, status, attempts: 0, addedAt: 1, updatedAt: 1, batchId: 'b',
  });
  assert.deepEqual(manifestsForBatch([q('1', 'complete'), q('2', 'downloading')], 'b'), []);
  const out = manifestsForBatch([q('1', 'complete'), q('2', 'failed')], 'b');
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0].json).files.length, 2);
  assert.ok(toDataUrl('héllo ✓').startsWith('data:application/json;charset=utf-8;base64,'));
  const done = [{ ...q('1', 'complete'), manifestDone: true }];
  assert.deepEqual(manifestsForBatch(done, 'b'), []);
});

test('settings: defaults, normalisation, clamping and persistence across "restarts"', async () => {
  const kv = new MemoryKV();
  assert.deepEqual(await loadSettings(kv), DEFAULT_SETTINGS);
  const s = normalizeSettings({ maxConcurrent: 99, maxRetries: -4, theme: 'neon' as any, rootFolder: 5 as any, types: { image: false } as any });
  assert.equal(s.maxConcurrent, 8); assert.equal(s.maxRetries, 0); assert.equal(s.theme, 'dark'); assert.equal(s.rootFolder, '4lodable');
  assert.deepEqual(s.types, { image: false, gif: true, video: true });
  await saveSettings(kv, { ...DEFAULT_SETTINGS, theme: 'light', maxConcurrent: 5 });
  const reopened = await loadSettings(kv); // a fresh read stands in for a browser restart
  assert.equal(reopened.theme, 'light'); assert.equal(reopened.maxConcurrent, 5);
});

test('history persists, upserts by id, and prunes oldest beyond the cap', async () => {
  const kv = new MemoryKV();
  await upsertHistory(kv, [hist('a', { timestamp: 1 }), hist('b', { timestamp: 2, status: 'failed' })]);
  await upsertHistory(kv, [hist('b', { timestamp: 3, status: 'complete' })]);
  const h = await loadHistory(kv);
  assert.equal(Object.keys(h).length, 2); assert.equal(h.b.status, 'complete');
  const big: Record<string, HistoryRecord> = {};
  for (let i = 0; i < 10; i++) big['r' + i] = hist('r' + i, { timestamp: i });
  assert.deepEqual(Object.keys(pruneHistory(big, 3)).sort(), ['r7', 'r8', 'r9']);
  assert.ok(HISTORY_CAP >= 1000);
});

test('concurrent history writes do not lose records', async () => {
  const kv = new MemoryKV();
  const get = kv.get.bind(kv);
  kv.get = async (k) => { await new Promise((r) => setTimeout(r, 2)); return get(k); }; // widen the race window
  await Promise.all(Array.from({ length: 25 }, (_, i) => upsertHistory(kv, [hist('c' + i, { timestamp: i })])));
  assert.equal(Object.keys(await loadHistory(kv)).length, 25);
});

test('storage quota exhaustion trims old history, and surfaces an error when it still cannot save', async () => {
  const kv = new MemoryKV();
  await upsertHistory(kv, Array.from({ length: 50 }, (_, i) => hist('x' + i, { timestamp: i })));
  kv.quotaBytes = JSON.stringify(kv.data).length + 10;
  await upsertHistory(kv, [hist('new', { timestamp: 999 })]); // needs trimming to fit
  const h = await loadHistory(kv);
  assert.ok(h.new); assert.ok(Object.keys(h).length < 51);
  kv.quotaBytes = 10;
  await assert.rejects(upsertHistory(kv, [hist('z')]), StorageQuotaError);
});

test('manifest export: JSON and CSV (quoting + formula-injection guard)', () => {
  const rows = [hist('a', { originalFilename: 'he said "hi", ok.png' }), hist('b', { originalFilename: '=HYPERLINK("x")', status: 'failed', error: 'boom' })];
  const csv = toCsv(rows).trim().split('\r\n');
  assert.equal(csv.length, 3);
  assert.ok(csv[1].includes('"he said ""hi"", ok.png"'));
  assert.ok(csv[2].includes(`"'=HYPERLINK(""x"")"`));
  assert.equal(csvCell('+1'), "'+1");
  const j = JSON.parse(toJson(rows));
  assert.equal(j.count, 2); assert.equal(j.files[1].status, 'failed'); assert.equal(j.files[0].board, 'g');
});
