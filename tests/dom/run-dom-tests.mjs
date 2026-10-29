// Runs the real content-script scanner against HTML fixtures in a real browser DOM (Playwright Chromium).
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fx = (n) => readFileSync(resolve(root, 'tests/fixtures', n), 'utf8');
const bundle = await esbuild.build({
  stdin: { contents: `import {scanDocument,scanThreadList} from './src/content/media-scanner.ts'; window.__s={scanDocument,scanThreadList};`, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, format: 'iife', absWorkingDir: root,
});
const code = bundle.outputFiles[0].text;
const archiveBundle = await esbuild.build({
  stdin: { contents: `import {scan,scanThreadList} from './src/adapters/archiveofsins.ts'; window.__a={scan,scanThreadList};`, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, format: 'iife', absWorkingDir: root,
});
const archiveCode = archiveBundle.outputFiles[0].text;

const browser = await chromium.launch();
const page = await browser.newPage();
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };
const run = async (html, ctx, extra = '') => {
  await page.setContent(html);
  await page.addScriptTag({ content: code });
  return page.evaluate(async ([ctx, extra]) => {
    const known = new Set(), elements = new Map();
    const r = await window.__s.scanDocument(document, ctx, { known, elements, chunkSize: 2 });
    let second = null;
    if (extra === 'twice') second = (await window.__s.scanDocument(document, ctx, { known, elements })).items.length;
    return { items: r.items, warning: r.warning, second, elements: elements.size };
  }, [ctx, extra]);
};
const ctx = (o = {}) => ({ board: 'g', defaultThreadId: '1000', includeQuoted: false, baseUrl: 'https://boards.4chan.org/g/thread/1000', ...o });
const runArchive = async (html, ctx, extra = '') => {
  await page.setContent(html);
  await page.addScriptTag({ content: archiveCode });
  return page.evaluate(async ([ctx, extra]) => {
    const known = new Set(), elements = new Map();
    const r = await window.__a.scan(document, ctx, { known, elements, chunkSize: 2 });
    let second = null;
    if (extra === 'twice') second = (await window.__a.scan(document, ctx, { known, elements })).items.length;
    return { items: r.items, warning: r.warning };
  }, [ctx, extra]);
};
const actx = (o = {}) => ({ board: 'h', defaultThreadId: '8968486', includeQuoted: false, baseUrl: 'https://archiveofsins.com/h/thread/8968486/', ...o });

await t('thread: finds originals, ignores thumbs, stray text links, untrusted hosts, inline quote copies', async () => {
  const r = await run(fx('thread.html'), ctx(), 'twice');
  assert.deepEqual(r.items.map((i) => i.tim), ['1700000000001', '1700000000002', '1700000000003', '1700000000005']);
  assert.deepEqual(r.items.map((i) => i.type), ['image', 'gif', 'video', 'video']);
  assert.equal(r.second, 0, 'rescan reports nothing new');
  assert.ok(r.items.every((i) => i.url.startsWith('https://i.4cdn.org/g/') && !i.url.includes('s.jpg')));
});
await t('thread: metadata (post number, thread, full original filename from title, size, dimensions)', async () => {
  const [a, b] = (await run(fx('thread.html'), ctx())).items;
  assert.equal(a.postNo, '1000'); assert.equal(a.threadId, '1000');
  assert.equal(a.originalName, 'my vacation photo with a very long name');
  assert.equal(a.size, Math.round(2.5 * 1024 * 1024)); assert.equal([a.width, a.height].join('x'), '1920x1080');
  assert.equal(b.originalName, 'funny'); assert.equal(b.postNo, '1001'); assert.equal(b.size, 850 * 1024);
  assert.equal(a.thumbUrl, 'https://i.4cdn.org/g/1700000000001s.jpg');
});
await t('thread: duplicate file in a later post is deduped (first occurrence wins)', async () => {
  const r = await run(fx('thread.html'), ctx());
  assert.equal(r.items.filter((i) => i.tim === '1700000000001').length, 1);
  assert.equal(r.items[0].postNo, '1000');
});
await t('includeQuoted=true also includes media inside inline-expanded copies', async () => {
  const r = await run(fx('thread.html'), ctx({ includeQuoted: true }));
  assert.ok(r.items.some((i) => i.tim === '1700000000006'));
});
await t('board page: media grouped by their own thread', async () => {
  const r = await run(fx('board.html'), ctx({ defaultThreadId: '', baseUrl: 'https://boards.4chan.org/g/' }));
  assert.deepEqual(r.items.map((i) => [i.tim.slice(-1), i.threadId, i.type]), [['1', '2000', 'image'], ['2', '2000', 'image'], ['3', '3000', 'gif']]);
});
await t('board page: thread list; catalog: thread list with teaser/replies', async () => {
  await page.setContent(fx('board.html')); await page.addScriptTag({ content: code });
  assert.deepEqual(await page.evaluate(() => window.__s.scanThreadList(document).map((x) => x.id)), ['2000', '3000']);
  await page.setContent(fx('catalog.html')); await page.addScriptTag({ content: code });
  const th = await page.evaluate(() => window.__s.scanThreadList(document));
  assert.deepEqual(th.map((x) => x.id), ['4000', '5000']);
  assert.match(th[0].teaser, /Catalog thread one/); assert.equal(th[0].replies, 12);
});
await t('changed page structure: falls back to generic detection and warns', async () => {
  const r = await run(fx('changed-layout.html'), ctx());
  assert.equal(r.items.length, 2); assert.match(r.warning, /layout looks different/);
});
await t('skipped media is reported with reasons (unsupported type, untrusted host, odd layout); is2 host still works', async () => {
  await page.setContent(fx('ignored.html')); await page.addScriptTag({ content: code });
  const r = await page.evaluate(async (c) => { const byHref = new Map(); const x = await window.__s.scanDocument(document, c, { onIgnored: (h, reason, detail) => byHref.set(h, [reason, detail]) }); return { tims: x.items.map((i) => i.tim), ig: [...byHref.values()] }; }, ctx());
  assert.deepEqual(r.tims, ['1700000000023']);                      // only the is2.4chan.org png is accepted
  const key = (a) => a.map((x) => x.join(':')).sort();
  assert.deepEqual(key(r.ig), key([['type', '.swf'], ['type', '.pdf'], ['host', 'i2.4cdn.org'], ['layout', 'file link outside the usual post markup']]));
});
await t('empty page yields no items and no crash', async () => {
  const r = await run('<html><body><p>nothing</p></body></html>', ctx());
  assert.equal(r.items.length, 0);
});
await t('large page (5,000 posts) scans quickly in chunks', async () => {
  const posts = Array.from({ length: 5000 }, (_, i) => `<div class="thread" id="t1"><div class="post reply" id="p${i + 10}"><div class="file"><div class="fileText">File: <a href="//i.4cdn.org/g/${1700000100000 + i}.jpg">a${i}.jpg</a> (10 KB, 10x10)</div><a class="fileThumb" href="//i.4cdn.org/g/${1700000100000 + i}.jpg"><img src="//i.4cdn.org/g/${1700000100000 + i}s.jpg"></a></div></div></div>`).join('');
  await page.setContent(`<body>${posts}</body>`); await page.addScriptTag({ content: code });
  const r = await page.evaluate(async (c) => { const t0 = performance.now(); const x = await window.__s.scanDocument(document, c, { chunkSize: 250 }); return { n: x.items.length, ms: performance.now() - t0 }; }, ctx());
  assert.equal(r.n, 5000); assert.ok(r.ms < 5000, `took ${r.ms}ms`);
  console.log(`      5000 items in ${Math.round(r.ms)}ms`);
});
await t('cancellation stops a scan between chunks', async () => {
  await page.setContent(fx('thread.html')); await page.addScriptTag({ content: code });
  const r = await page.evaluate(async (c) => (await window.__s.scanDocument(document, c, { chunkSize: 1, shouldCancel: () => true })).cancelled, ctx());
  assert.equal(r, true);
});
await t('archive thread: image/gif/webm posts yield 3 items, removed-file post is ignored, text-only post yields nothing', async () => {
  const r = await runArchive(fx('archive-thread.html'), actx());
  assert.deepEqual(r.items.map((i) => i.type), ['image', 'gif', 'video']);
  assert.ok(r.items.every((i) => i.site === 'archiveofsins'));
  const [img, gif, webm] = r.items;
  assert.equal(img.originalName, 'my vacation photo with a very long name');
  assert.equal(img.size, Math.round(2.5 * 1024 * 1024));
  assert.equal([img.width, img.height].join('x'), '1920x1080');
  assert.equal(gif.originalName, 'funny'); assert.equal(gif.size, 850 * 1024);
  assert.equal(webm.originalName, 'clip');
});
await t('archive thread: removed-file post reports onIgnored("removed", ...) and no item', async () => {
  await page.setContent(fx('archive-thread.html')); await page.addScriptTag({ content: archiveCode });
  const r = await page.evaluate(async (c) => {
    const ig = [];
    const x = await window.__a.scan(document, c, { onIgnored: (h, reason, detail) => ig.push([reason, detail]) });
    return { n: x.items.length, ig };
  }, actx());
  assert.equal(r.n, 3);
  assert.deepEqual(r.ig.map((x) => x[0]), ['removed']);
});
await t('archive board: lists 3 threads', async () => {
  const r = await runArchive(fx('archive-board.html'), actx({ defaultThreadId: '' }));
  assert.equal(r.items.length, 3);
  await page.setContent(fx('archive-board.html')); await page.addScriptTag({ content: archiveCode });
  const ids = await page.evaluate(() => window.__a.scanThreadList(document).map((x) => x.id));
  assert.deepEqual(ids, ['9000001', '9000002', '9000003']);
});
await t('archive: changed page structure falls back to generic detection and warns', async () => {
  const r = await runArchive(fx('archive-changed-layout.html'), actx());
  assert.equal(r.items.length, 2); assert.match(r.warning, /layout looks different/);
});
await t('archive: replies nested in a file-less OP are attributed to their own post, not the OP', async () => {
  const r = await runArchive(fx('archive-nested.html'), actx({ defaultThreadId: '' }));
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].postNo, '7000002'); assert.equal(r.items[0].threadId, '7000001');
  assert.equal(r.items[0].originalName, 'reply file'); assert.equal(r.items[0].width, 10);
});

await browser.close();
console.log(`\n${passed} DOM tests passed`);
