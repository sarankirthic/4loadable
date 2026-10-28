// End-to-end: loads dist/ into real Chromium. 4chan hostnames are remapped to a local HTTPS server (no real network).
// Usage: npm run build && node tests/dom/e2e.mjs   (needs a Chromium that supports extensions)
import { chromium } from 'playwright';
import https from 'node:https';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fx = (n) => readFileSync(resolve(root, 'tests/fixtures', n));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const hits = [];
const server = https.createServer({ key: readFileSync(process.env.E2E_KEY ?? '/tmp/e2e/k.pem'), cert: readFileSync(process.env.E2E_CERT ?? '/tmp/e2e/c.pem') }, (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0]; hits.push(`${host}${req.url}`);
  const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', ...extra }); res.end(body); };
  if (host === 'boards.4chan.org') return send(200, 'text/html', fx(req.url.includes('/thread/') ? 'thread.html' : 'board.html'));
  if (host === 'a.4cdn.org') return req.url.endsWith('threads.json') ? send(200, 'application/json', '[{"page":1,"threads":[{"no":1000,"replies":4}]}]') : send(200, 'application/json', fx('thread.json'));
  if (host === 'i.4cdn.org') {
    if (req.url.includes('1700000000005')) return send(404, 'text/plain', 'gone');    // simulate a deleted file
    return send(200, req.url.endsWith('.gif') ? 'image/gif' : req.url.endsWith('.webm') ? 'video/webm' : 'image/png', PNG);
  }
  send(404, 'text/plain', 'no');
});
await new Promise((r) => server.listen(8443, r));

const userData = mkdtempSync(join(tmpdir(), 'cmd-e2e-'));
const ctx = await chromium.launchPersistentContext(userData, {
  channel: 'chromium', headless: true, acceptDownloads: true, ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${root}/dist`, `--load-extension=${root}/dist`, '--ignore-certificate-errors',
    '--host-resolver-rules=MAP boards.4chan.org 127.0.0.1:8443, MAP a.4cdn.org 127.0.0.1:8443, MAP i.4cdn.org 127.0.0.1:8443'],
});
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);
try {
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto('https://boards.4chan.org/g/thread/1000');
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://boards.4chan.org/*' }))[0].id);
  await page.waitForFunction(() => document.querySelector('#cmd-toolbar-host'), null, { timeout: 10000 });
  ok('content script injected; in-page toolbar mounted');

  let scan;
  for (let i = 0; i < 40 && !(scan?.items?.length >= 4); i++) { await new Promise((r) => setTimeout(r, 250)); scan = (await sw.evaluate((k) => chrome.storage.session.get(k), `scan:${tabId}`))[`scan:${tabId}`]; }
  assert.equal(scan.items.length, 4); assert.equal(scan.page.kind, 'thread');
  ok(`scan state stored in background: ${scan.items.map((i) => i.type).join(',')}`);

  // dynamic content: a new post appears
  await page.evaluate(() => { const d = document.createElement('div'); d.className = 'postContainer replyContainer'; d.id = 'pc1100'; d.innerHTML = '<div class="post reply" id="p1100"><div class="file"><div class="fileText">File: <a href="//i.4cdn.org/g/1700000000009.webm">new.webm</a> (1 MB, 1x1)</div><a class="fileThumb" href="//i.4cdn.org/g/1700000000009.webm"><img src="//i.4cdn.org/g/1700000000009s.jpg"></a></div></div>'; document.querySelector('.thread').appendChild(d); });
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 250)); scan = (await sw.evaluate((k) => chrome.storage.session.get(k), `scan:${tabId}`))[`scan:${tabId}`]; if (scan.items.length === 5) break; }
  assert.equal(scan.items.length, 5); ok('dynamically inserted post detected');

  // manager UI: render, download everything
  const mgr = await ctx.newPage();
  await mgr.goto(`chrome-extension://${extId}/manager.html?tab=${tabId}`);
  await mgr.getByText('Showing 5 of 5').waitFor({ timeout: 10000 });
  ok('manager renders 5 detected items');
  await mgr.getByRole('button', { name: /Download all/ }).click();
  await mgr.getByRole('button', { name: /^Download 5$/ }).click();

  let q = [];
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    q = (await sw.evaluate(() => chrome.storage.local.get('queue'))).queue ?? [];
    if (q.length === 5 && q.every((x) => ['complete', 'failed'].includes(x.status))) break;
  }
  const by = (s) => q.filter((x) => x.status === s).length;
  console.log('      queue:', q.map((x) => `${x.path.split('/').slice(1).join('/')}=${x.status}`).join(' | '));
  assert.equal(by('complete'), 4, 'four files complete'); assert.equal(by('failed'), 1, 'the 404 file fails');
  assert.match(q.find((x) => x.status === 'failed').error, /not found/i);
  assert.equal(q.find((x) => x.status === 'failed').attempts, 0, 'permanent errors are not retried');
  ok('4 completed (browser-confirmed), 1 failed with clear reason and no pointless retries');

  // Playwright renames browser downloads to UUIDs, so verify the paths the extension requested instead.
  const paths = q.map((x) => x.path);
  for (const want of ['4lodable/g/1000/images/my vacation photo with a very long name.jpg', '4lodable/g/1000/gifs/funny.gif', '4lodable/g/1000/videos/clip.webm'])
    assert.ok(paths.includes(want), want);
  ok('requested paths follow 4lodable/<board>/<thread>/{images,gifs,videos}/<original filename>');
  await new Promise((r) => setTimeout(r, 1500));
  const dls = await sw.evaluate(() => new Promise((r) => chrome.downloads.search({}, r)));
  assert.equal(dls.length, 6, 'five files plus exactly one thread-level manifest.json');
  assert.ok(dls.filter((d) => d.url.startsWith('data:application/json')).length === 1);
  ok('one thread-level manifest.json written after the batch finished');

  const hist = (await sw.evaluate(() => chrome.storage.local.get('history'))).history;
  assert.equal(Object.keys(hist).length, 5); assert.equal(Object.values(hist).filter((h) => h.status === 'failed').length, 1);
  ok('history recorded (including the failure)');

  // retry the failure: it fails again, deterministically, but is re-attempted
  const before = hits.filter((h) => h.includes('1700000000005')).length;
  await mgr.getByRole('tab', { name: /Queue/ }).click();
  await mgr.getByRole('button', { name: 'Retry failed' }).click();
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(hits.filter((h) => h.includes('1700000000005')).length > before); ok('Retry failed re-attempts the file');

  // "skip already downloaded" suppresses re-downloads
  await sw.evaluate(async () => { const s = (await chrome.storage.local.get('settings')).settings ?? {}; await chrome.storage.local.set({ settings: { ...s, duplicates: 'skip' } }); });
  const n = hits.filter((h) => h.startsWith('i.4cdn.org') && h.includes('1700000000002')).length;
  await mgr.getByRole('tab', { name: /Media/ }).click();
  await mgr.getByRole('button', { name: /Download all/ }).click();
  await mgr.getByRole('button', { name: /^Download 5$/ }).click();
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(hits.filter((h) => h.startsWith('i.4cdn.org') && h.includes('1700000000002')).length, n, 'no re-download of known file');
  ok('duplicate handling "skip" avoids re-downloading known files');

  // API cross-check adds files the page scan did not see (fixture API lists 3 extra files)
  await mgr.getByRole('tab', { name: /Media/ }).click();
  await mgr.getByRole('button', { name: 'Add missing files from 4chan API' }).click();
  await mgr.getByText('Showing 8 of 8').waitFor({ timeout: 15000 });
  ok('API cross-check added the 3 files missing from the page (8 total, no duplicates)');

  // popup shows counts
  const pop = await ctx.newPage(); await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.getByText('4loadable').first().waitFor(); ok('popup renders');
  console.log(`\nE2E passed (${step} checks)`);
} catch (e) { console.error('E2E FAILED:', e); process.exitCode = 1; }
finally { await ctx.close(); server.close(); }
