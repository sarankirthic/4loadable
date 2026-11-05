// Mounts the real LibraryPanel in Playwright Chromium with an in-memory folder (tests/fake-fs.ts) and fake deps:
// no chrome.*, no real File System Access API.
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = `
import { createRoot } from 'react-dom/client';
import './src/ui/ui.css';
import { LibraryPanel } from './src/media-manager/LibraryPanel.tsx';
import { FakeFileHandle, makeFakeDir, makeFakeFile } from './tests/fake-fs.ts';

// fake-fs returns a blob-shaped object; the browser needs a real File (object URLs, createImageBitmap).
const fakeGetFile = FakeFileHandle.prototype.getFile;
FakeFileHandle.prototype.getFile = async function () {
  const b = await fakeGetFile.call(this);
  return new File([await b.arrayBuffer()], b.name, { lastModified: b.lastModified });
};

// Counters: createImageBitmap/ImageBitmap.close and createObjectURL/revokeObjectURL.
const c = { bitmaps: 0, closed: 0, live: new Map(), urls: 0, revoked: 0, moves: 0 };
const realBitmap = window.createImageBitmap.bind(window);
window.createImageBitmap = async (file) => { const b = await realBitmap(new ImageData(2, 2)); c.bitmaps++; c.live.set(b, file.name); return b; };
const realClose = ImageBitmap.prototype.close;
ImageBitmap.prototype.close = function () { if (c.live.delete(this)) c.closed++; return realClose.call(this); };
const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
URL.createObjectURL = (b) => { c.urls++; return realCreate(b); };
URL.revokeObjectURL = (u) => { c.revoked++; return realRevoke(u); };

// hold.at = n makes the n-th move wait until hold.release() is called (to cancel mid-run).
const hold = { at: 0, release: () => {} };
const file = (name) => {
  const f = makeFakeFile(name, { content: new Uint8Array([1, 2, 3]), supportsMove: true, lastModified: 1700000000000 });
  const move = f.move;
  f.move = async (...a) => {
    if (++c.moves === hold.at) await new Promise((r) => { hold.release = r; });
    return move(...a);
  };
  return f;
};
const dir = (name, kids) => { const d = makeFakeDir(name); for (const k of kids) d.setChild(k.name, k); return d; };

let reactRoot = null;
window.__lib = {
  c, hold,
  mount({ big = 0, writable = true } = {}) {
    reactRoot?.unmount();
    c.bitmaps = c.closed = c.urls = c.revoked = c.moves = 0; c.live.clear(); hold.at = 0;
    const kids = big
      ? [dir('alpha', []), dir('beta', []), ...Array.from({ length: big }, (_, i) => file('f' + String(i).padStart(4, '0') + '.png'))]
      : [file('a.png'), file('b.png'), file('c.png'), dir('dest', [file('b.png')])];
    const fsRoot = dir('Library', kids);
    const perm = (m) => (m === 'read' || writable ? 'granted' : 'prompt');
    Object.assign(fsRoot, { queryPermission: async ({ mode }) => perm(mode), requestPermission: async ({ mode }) => (perm(mode) === 'granted' ? 'granted' : 'denied') });
    let journal = [];
    const sent = [], notes = [];
    const deps = {
      handleStore: { get: async () => fsRoot, set: async () => {}, clear: async () => {} },
      pickDirectory: async () => fsRoot,
      browserSource: null,
      journal: { load: async () => journal.map((e) => ({ ...e, ops: e.ops.map((o) => ({ ...o })) })), save: async (j) => { journal = j; } },
      send: (m) => sent.push(m),
    };
    const el = document.getElementById('root');
    reactRoot = createRoot(el);
    reactRoot.render(<LibraryPanel rootFolder="4loadable" notify={(m) => notes.push(m)} queueActive={false} deps={deps} />);
    const names = (path) => { let d = fsRoot; for (const s of path) d = d.getChild(s); return [...d['children'].keys()].sort(); };
    Object.assign(window.__lib, { fsRoot, names, sent, notes, journal: () => journal });
  },
};
`;
const built = await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: 'tsx', sourcefile: 'library-dom-entry.tsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', absWorkingDir: root, outdir: 'out',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const js = built.outputFiles.find((f) => f.path.endsWith('.js')).text;
const css = built.outputFiles.find((f) => f.path.endsWith('.css')).text;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };
const mount = async (opts) => {
  await page.setContent('<html><body><div id="root" style="height:100%;display:flex;flex-direction:column"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: js });
  await page.evaluate((o) => window.__lib.mount(o), opts);
};
const lib = (fn, arg) => page.evaluate(fn, arg);
const tree = () => page.getByRole('complementary', { name: 'Folders' });
const row = (name) => page.locator('.pane .treerow', { has: page.getByRole('button', { name, exact: true }) });
// Also records the most cards ever rendered while the source switches to writable (regression: a re-scan
// once rendered every entry twice).
const enableOrganizing = async () => {
  await page.evaluate(() => {
    window.__maxRows = 0;
    new MutationObserver(() => { window.__maxRows = Math.max(window.__maxRows, document.querySelectorAll('.pane .treerow').length); })
      .observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole('button', { name: 'Enable organizing' }).click();
  await page.getByRole('toolbar', { name: 'Organize' }).waitFor();
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(() => window.__maxRows) <= 4, 'no duplicate cards during the re-scan');
};

await t('tree renders the root folders', async () => {
  await mount({ big: 5000 });
  await tree().getByRole('button', { name: 'alpha' }).waitFor();
  assert.deepEqual(await tree().getByRole('button').allTextContents(), ['Library', 'alpha', 'beta']);
});

await t('5,000 entries render fewer than 100 DOM cards', async () => {
  await page.getByText('5002 of 5002').waitFor();
  const n = await page.locator('.pane .treerow').count();
  assert.ok(n > 0 && n < 100, `${n} cards rendered`);
});

// Names of live (unclosed) bitmaps, and of cards actually inside the scroll viewport.
const thumbState = () => lib(() => {
  const sc = document.querySelector('.pane .scroll').getBoundingClientRect();
  const visible = [...document.querySelectorAll('.pane .treerow')].filter((r) => {
    const b = r.getBoundingClientRect();
    return b.bottom > sc.top && b.top < sc.bottom;
  }).map((r) => r.querySelector('.nm').textContent).filter((n) => n.endsWith('.png')); // folders get no thumbnail
  const { c } = window.__lib;
  return { visible, live: [...c.live.values()], bitmaps: c.bitmaps, closed: c.closed };
});
const settle = async (pred) => { for (let i = 0; i < 100; i++) { const s = await thumbState(); if (pred(s)) return s; await page.waitForTimeout(50); } return thumbState(); };

await t('thumbnails only for visible cards; bitmaps are closed after scrolling away', async () => {
  let s = await settle((x) => x.visible.length > 0 && x.visible.every((v) => x.live.includes(v)));
  assert.ok(s.visible.length > 0);
  assert.ok(s.live.every((n) => s.visible.includes(n)), `thumbnails off screen: ${s.live.filter((n) => !s.visible.includes(n))}`);
  assert.ok(s.visible.every((n) => s.live.includes(n)), 'every visible card has a thumbnail');
  assert.ok(s.bitmaps < 100, `${s.bitmaps} bitmaps created`);
  const first = s.live;

  // Re-scroll each poll: rows rendered after the first jump can still grow scrollHeight a little.
  const toBottom = () => page.locator('.pane .scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await toBottom();
  s = await settle((x) => (void toBottom(), x.visible.includes('f4999.png') && x.visible.every((v) => x.live.includes(v)) && x.live.every((n) => x.visible.includes(n))));
  assert.ok(s.visible.includes('f4999.png'), JSON.stringify(s.visible));
  assert.ok(s.live.every((n) => s.visible.includes(n)), `still live after scroll: ${s.live.filter((n) => !s.visible.includes(n))}`);
  assert.ok(first.every((n) => !s.live.includes(n)), 'bitmaps of scrolled-away cards are released');
  assert.equal(s.closed, s.bitmaps - s.live.length, 'every bitmap not on screen was closed');
  assert.ok(s.bitmaps < 200, `${s.bitmaps} bitmaps created in total`);
});

await t('preview opens and closes (Close button and Escape); its object URL is revoked', async () => {
  await page.locator('.pane .scroll').evaluate((el) => { el.scrollTop = 0; });
  const dialog = page.getByRole('dialog', { name: 'Preview' });
  await page.getByRole('button', { name: 'f0001.png', exact: true }).click();
  await dialog.getByRole('img', { name: 'f0001.png' }).waitFor();
  await dialog.getByRole('button', { name: 'Close preview' }).click();
  await dialog.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'f0002.png', exact: true }).click();
  await dialog.getByRole('img', { name: 'f0002.png' }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const { urls, revoked } = await lib(() => window.__lib.c);
  assert.ok(urls >= 2); assert.equal(revoked, urls);
});

const select = async (...names) => { for (const n of names) await page.getByRole('checkbox', { name: `Select ${n}` }).click(); };
const moveToDest = async () => {
  await page.getByRole('toolbar', { name: 'Organize' }).getByRole('button', { name: 'Move to…' }).click();
  const picker = page.getByRole('dialog', { name: 'Move to…' });
  await picker.getByRole('button', { name: 'dest', exact: true }).click();
  await picker.getByRole('button', { name: 'Move here' }).click();
};
const planned = (dialog) => dialog.getByRole('list', { name: 'Planned changes' }).getByRole('listitem').allTextContents();
const names = (path = []) => lib((p) => window.__lib.names(p), path);

await t('Move to… shows the preview; confirming moves the files and updates the grid; Undo last restores them', async () => {
  await mount({});
  await enableOrganizing();
  await select('a.png', 'c.png');
  await moveToDest();
  const dialog = page.getByRole('dialog', { name: 'Move 2 files to dest' });
  await dialog.getByRole('list', { name: 'Planned changes' }).waitFor();
  assert.deepEqual(await planned(dialog), ['Move: a.png → dest/a.png', 'Move: c.png → dest/c.png']);
  assert.deepEqual(await names(), ['a.png', 'b.png', 'c.png', 'dest'], 'nothing moves before Confirm');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await dialog.getByRole('status').getByText('2 done, 0 skipped, 0 failed').waitFor();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await row('a.png').waitFor({ state: 'detached' });
  assert.deepEqual(await names(), ['b.png', 'dest']);
  assert.deepEqual(await names(['dest']), ['a.png', 'b.png', 'c.png']);
  assert.equal(await page.locator('.pane .treerow').count(), 2, 'grid shows b.png and dest');
  const sent = await lib(() => window.__lib.sent);
  assert.deepEqual(sent, [{ type: 'LIBRARY_PATHS_CHANGED', changes: [{ from: ['a.png'], to: ['dest', 'a.png'] }, { from: ['c.png'], to: ['dest', 'c.png'] }] }]);

  await page.getByRole('button', { name: 'Undo last' }).click();
  const undo = page.getByRole('dialog', { name: 'Undo last' });
  await undo.getByRole('list', { name: 'Planned changes' }).waitFor();
  await undo.getByRole('button', { name: 'Confirm' }).click();
  await undo.getByRole('status').getByText('2 done').waitFor();
  await undo.getByRole('button', { name: 'Close' }).click();
  await row('a.png').waitFor();
  await row('c.png').waitFor();
  assert.deepEqual(await names(), ['a.png', 'b.png', 'c.png', 'dest']);
  assert.deepEqual(await names(['dest']), ['b.png']);
  assert.equal(await lib(() => window.__lib.journal().length), 0);
  assert.ok(await page.getByRole('button', { name: 'Undo last' }).isDisabled());
});

await t('a name collision shows the -2 rename in the preview', async () => {
  await mount({});
  await enableOrganizing();
  await select('b.png');
  await moveToDest();
  const dialog = page.getByRole('dialog', { name: 'Move 1 file to dest' });
  await dialog.getByRole('list', { name: 'Planned changes' }).waitFor();
  assert.deepEqual(await planned(dialog), ['Move: b.png → dest/b-2.png']);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(await names(['dest']), ['b.png'], 'cancelled preview changes nothing');
});

await t('cancelling mid-run keeps completed moves and leaves the cancelled source intact', async () => {
  await mount({});
  await enableOrganizing();
  await select('a.png', 'b.png', 'c.png');
  await lib(() => { window.__lib.hold.at = 2; }); // the 2nd move waits until released
  await moveToDest();
  const dialog = page.getByRole('dialog', { name: 'Move 3 files to dest' });
  await dialog.getByRole('list', { name: 'Planned changes' }).waitFor();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await dialog.getByText('1 / 3').waitFor();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await lib(() => window.__lib.hold.release());
  await dialog.getByRole('status').getByText('2 done, 0 skipped, 0 failed, 1 not attempted (cancelled)').waitFor();
  assert.deepEqual(await names(), ['c.png', 'dest']);
  assert.deepEqual(await names(['dest']), ['a.png', 'b-2.png', 'b.png']);
  assert.deepEqual((await lib(() => window.__lib.journal())).at(-1).ops.map((o) => o.done), [true, true, false]);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await row('a.png').waitFor({ state: 'detached' });
  await row('c.png').waitFor();
});

await t('Rename to "../x" shows a validation error and runs nothing', async () => {
  await mount({});
  await enableOrganizing();
  await select('a.png');
  await page.getByRole('toolbar', { name: 'Organize' }).getByRole('button', { name: 'Rename', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: 'Rename a.png' });
  await prompt.getByRole('textbox', { name: 'Name' }).fill('../x');
  await prompt.getByRole('alert').getByText('Names cannot be empty').waitFor();
  assert.ok(await prompt.getByRole('button', { name: 'Continue' }).isDisabled());
  await prompt.getByRole('textbox', { name: 'Name' }).press('Enter');
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button', { name: 'Confirm' }).count(), 0, 'no operation preview opened');
  assert.deepEqual(await names(), ['a.png', 'b.png', 'c.png', 'dest']);
  assert.equal(await lib(() => window.__lib.journal().length), 0);
  assert.deepEqual(await lib(() => window.__lib.sent), []);
});

await t('organize controls are absent when the source is read-only', async () => {
  await mount({ writable: false });
  await row('a.png').waitFor();
  assert.equal(await page.getByRole('toolbar', { name: 'Organize' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Move to…' }).count(), 0);
  assert.equal(await row('a.png').getAttribute('draggable'), 'false');
  await page.getByRole('button', { name: 'Enable organizing' }).click(); // write permission is refused
  await page.waitForFunction(() => window.__lib.notes.length > 0);
  assert.match((await lib(() => window.__lib.notes))[0], /Write access was not granted/);
  assert.equal(await page.getByRole('toolbar', { name: 'Organize' }).count(), 0);
});

await browser.close();
assert.deepEqual(errors, [], 'no page errors');
console.log(`\n${passed} library DOM tests passed`);
