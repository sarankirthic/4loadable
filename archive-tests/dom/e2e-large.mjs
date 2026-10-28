// Stress test: 400-file thread and 600-file board through the real extension (scan -> manager -> select -> queue).
import { chromium } from 'playwright';
import https from 'node:https';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const post = (tim, n, thread) => `<div class="postContainer replyContainer" id="pc${n}"><div class="post reply" id="p${n}"><div class="file"><div class="fileText">File: <a href="//i.4cdn.org/g/${tim}.png">pic${n}.png</a> (10 KB, 10x10)</div><a class="fileThumb" href="//i.4cdn.org/g/${tim}.png"><img src="//i.4cdn.org/g/${tim}s.jpg"></a></div></div></div>`;
const threadHtml = (N) => `<html><body><div class="thread" id="t3000">${Array.from({ length: N }, (_, i) => post(1800000000000 + i, 3000 + i)).join('')}</div></body></html>`;
// board page: 40 threads x 15 files = 600
const boardHtml = `<html><body>${Array.from({ length: 40 }, (_, t) => `<div class="thread" id="t${5000 + t}">${Array.from({ length: 15 }, (_, i) => post(1810000000000 + t * 100 + i, 5000 + t * 100 + i)).join('')}</div>`).join('')}</body></html>`;

const server = https.createServer({ key: readFileSync('/tmp/e2e/k.pem'), cert: readFileSync('/tmp/e2e/c.pem') }, (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const send = (c, t, b) => { res.writeHead(c, { 'content-type': t, 'access-control-allow-origin': '*' }); res.end(b); };
  if (host === 'boards.4chan.org') return send(200, 'text/html', req.url.includes('/thread/') ? threadHtml(400) : boardHtml);
  send(200, 'image/png', PNG);
});
await new Promise((r) => server.listen(8443, r));
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'cmd-big-')), {
  channel: 'chromium', headless: true, ignoreHTTPSErrors: true, viewport: { width: 1200, height: 800 },
  args: [`--disable-extensions-except=${root}/dist`, `--load-extension=${root}/dist`, '--ignore-certificate-errors',
    '--host-resolver-rules=MAP boards.4chan.org 127.0.0.1:8443, MAP i.4cdn.org 127.0.0.1:8443'],
});
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);
try {
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  for (const [label, url, expected] of [['thread (400 files)', 'https://boards.4chan.org/g/thread/3000', 400], ['board page (600 files)', 'https://boards.4chan.org/g/', 600]]) {
    const page = await ctx.newPage(); await page.goto(url);
    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);
    let got = 0;
    for (let i = 0; i < 60 && got < expected; i++) { await new Promise((r) => setTimeout(r, 300)); got = ((await sw.evaluate((k) => chrome.storage.session.get(k), `scan:${tabId}`))[`scan:${tabId}`]?.items ?? []).length; }
    assert.equal(got, expected, `${label}: background holds ${got}`);
    ok(`${label}: all ${got} files reached the background`);

    const mgr = await ctx.newPage(); await mgr.goto(`chrome-extension://${extId}/manager.html?tab=${tabId}`);
    await mgr.getByText(`Showing ${expected} of ${expected}`).waitFor({ timeout: 15000 });
    const rendered = await mgr.locator('.card').count();
    assert.ok(rendered > 0 && rendered < 120, `virtualized: ${rendered} cards in DOM`);
    // scroll to the very end; the last file must become reachable
    const lastName = label.startsWith('thread') ? `pic${3000 + expected - 1}.png` : `pic${5000 + 39 * 100 + 14}.png`;
    await mgr.evaluate(async () => { const el = document.querySelector('.scroll'); for (let i = 0; i < 400; i++) { el.scrollTop += 700; await new Promise((r) => setTimeout(r, 5)); } });
    await mgr.getByText(lastName, { exact: true }).first().waitFor({ timeout: 8000 });
    ok(`${label}: manager shows all ${expected} (only ${rendered} cards in the DOM), last file "${lastName}" reachable by scrolling`);

    await mgr.getByRole('button', { name: 'All', exact: true }).click();
    await mgr.getByText(`${expected} selected`).waitFor();
    await mgr.getByRole('button', { name: 'Download selected' }).click();
    await mgr.getByRole('button', { name: new RegExp(`^Download ${expected}$`) }).click();
    let q = [];
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 300)); q = (await sw.evaluate(() => chrome.storage.local.get('queue'))).queue ?? []; if (q.filter((x) => x.batchId && x.id.startsWith('g:18') ).length >= expected) break; }
    const mine = q.filter((x) => x.url.includes(label.startsWith('thread') ? '/1800000' : '/1810000'));
    assert.equal(mine.length, expected, `queued ${mine.length}`);
    assert.equal(new Set(mine.map((x) => x.path)).size, expected, 'all paths unique');
    ok(`${label}: selecting all and downloading queued ${mine.length} unique files`);
    await mgr.close(); await page.close();
  }
  console.log(`\nLarge-batch E2E passed (${n} checks)`);
} catch (e) { console.error('LARGE E2E FAILED:', e); process.exitCode = 1; }
finally { await ctx.close(); server.close(); }
