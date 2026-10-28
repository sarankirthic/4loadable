# archiveofsins.com Site Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `SiteAdapter`-based architecture to the 4loadable extension so it can scan and download media from archiveofsins.com (a FoolFuuka-style 4chan archive) alongside 4chan, without changing 4chan's existing behavior except the intentional folder-layout change below.

**Architecture:** Introduce a `SiteAdapter` interface. Wrap the existing 4chan logic (`content/page-detector.ts`, `content/media-scanner.ts`, `shared/media-detection.ts`) as the `fourchan` adapter without moving that code — a thin adapter object references the existing exports, so behavior and all current test imports are unaffected. Add a new `archiveofsins` adapter with its own DOM scanner, URL parser and host allowlist, built from real markup captured live from archiveofsins.com (see Ground Truth below), not guessed. `content/index.ts` picks an adapter by hostname via a small registry. The archive site is opt-in: declared in `optional_host_permissions`, requested via `chrome.permissions.request` on a user click, with its content script registered dynamically via `chrome.scripting.registerContentScripts` only after the grant.

**Tech Stack:** TypeScript, esbuild, Playwright (DOM fixtures), node:test (`tsx --test`), Chrome MV3 (`scripting`, `permissions` APIs).

**Spec:** User's own message in this conversation (archiveofsins adapter request, Steps 0–5 + constraints) plus the ground-truth findings below, which supersede the user's original Step 2/Step 4 scope on two points the user already approved:
- **Dropped:** JSON-API-backed "add missing files" for archiveofsins, and search/gallery page support. `robots.txt` on archiveofsins.com disallows `/_/*` (the FoolFuuka API), `/*/search/*` and `/*/gallery`. Only board-index and thread pages are in scope.
- **Unverified, proceeding anyway:** no live removed-file, GIF, or WebM post was found on archiveofsins.com during manual verification (checked ~750 posts across 3 threads/2 boards). The removed-file detector (`has_image` class without a `.post_file_filename` element) and the gif/webm extension classification are implemented from the real OP/reply markup pattern but are not confirmed against a live removed/gif/webm example.

## Ground Truth (verified live on archiveofsins.com, 2026-10-28)

- Media host = the page's own origin (`archiveofsins.com`), not a separate CDN.
- Full-size file: `https://archiveofsins.com/data/<board>/image/<ts4>/<ts2>/<mediaOrig>` where `<ts4>`/`<ts2>` are the first 4 and next 2 digits of `<mediaOrig>` (its filename, e.g. `1792171898073007.jpg`).
- Thumbnail: same path with `/image/` → `/thumb/` and `s` inserted before the extension, e.g. `.../thumb/1792/17/1792171898073007s.jpg`.
- Thread DOM: `article.thread` (OP) and `article.post` (replies), both with id = post number and a `has_image` class when they carry a file.
  - Full URL + thumbnail: `a.thread_image_link[href]` and `img.post_image[src][data-md5]` inside `.thread_image_box`.
  - Filename: `a.post_file_filename[title]` — the `title` attribute holds the untruncated original filename; the text node is elided with `(...)` for long names, so always read `title`, falling back to text only when `title` is absent.
  - Size/dimensions: `.post_file_metadata` as free text `"<size>, <W>x<H>"`, e.g. `"675KiB, 800x1000"` — **size first, then dimensions** (the opposite order the throwaway synthetic fixtures guessed), and sizes use binary-with-`i` units (`KiB`/`MiB`), not plain `KB`/`MB`.
  - `.post_file_controls` contains "View Same / Google / ImgOps / iqdb / SauceNAO" links plus a `download` anchor — ignore all of these; they are not the source link.
  - Removed-file signal (inferred, see above): `has_image` present but no `a.post_file_filename` under `.post_file`.
- Board index page (`https://archiveofsins.com/<board>/`) renders multiple `article.thread` blocks, same per-post markup as a thread page, one page of threads (no catalog concept to replicate for this site).
- Thread URL: `/<board>/thread/<num>/`. Board index URL: `/<board>/` (optionally `/<board>/<page>/`).
- `robots.txt`: `Disallow: /_/*`, `/*/search/*`, `/*/gallery`; `Crawl-delay: 5`. Confirms the API/search/gallery scope cut above.

## Global Constraints

- Do not change 4chan's scan/parse/detect *logic or output* in any way; all current `tests/*.test.ts` and `tests/dom/*` must keep passing unmodified in assertions about 4chan behavior.
- The one intentional, spec-required 4chan behavior change: download folder layout gains a leading site segment, `<site>/<board>/<thread>/<type>/` (was `<board>/<thread>/<type>/`). Tests asserting the old path shape must be updated to expect the new one — this is required, not a regression.
- No new npm dependencies (ladder: reuse existing Playwright/tsx/esbuild setup).
- `archiveofsins.com` must never appear in `host_permissions` — only `optional_host_permissions`, requested via `chrome.permissions.request` on a user gesture (a click), never on load.
- `chrome.scripting.registerContentScripts` for the archive site runs only after that permission grant succeeds.
- No analytics, no remote code, no extra network requests beyond what Step 2's scope now allows (DOM-only; no `/_/api`, `/search`, `/gallery` fetches).
- Archive media host allowlist is `archiveofsins.com` exactly — never a wildcard/global "allow any host" rule.

## Review Focus

- **Long/special-character filenames**: `.post_file_filename`'s text node truncates with `(...)`; a naive text-based filename read silently keeps the ellipsis in the saved filename. Test: adapter reads `title`, not text, when present.
- **Thumbnail links mistaken for full-size**: a `.thread_image_link` or `.post_image` pointing at `/thumb/...s.ext` must never be treated as a download target. Test: parser rejects/flags thumb paths the same way `isThumbnailUrl` does for 4chan.
- **Cross-site id collisions**: 4chan and archiveofsins can produce media with the same numeric-looking id in isolation; without a `site` prefix two unrelated files could dedupe into one. Test: same board+filename digits on both sites produce distinct `MediaItem.id`.
- **Permission not yet granted**: visiting archiveofsins.com before the user clicks "Enable" must not scan, fetch, or inject anything beyond the popup/options surface that offers the button. Test: no content script runs without the stored permission grant.
- **Untrusted/traversal media URLs**: a crafted `/data/../../etc/passwd`-shaped or `userinfo@`/non-standard-port archive URL must be rejected by the archive `parseMediaUrl`, mirroring the hardening already in `shared/media-detection.ts`'s 4chan parser. Test: unit tests for traversal, credentials, port, wrong host, unsupported extension.

---

## File Structure

- **Modify** `src/shared/types.ts` — add `site: string` to `MediaItem`, `PageInfo`, `QueueItem`, `HistoryRecord`.
- **Modify** `src/shared/media-detection.ts` — `mediaId(site, board, tim)`; extend `parseFileSize` to accept `KiB/MiB/GiB` units (additive, 4chan output unaffected).
- **Create** `src/shared/site-adapter.ts` — `SiteAdapter` interface + `ADAPTERS: SiteAdapter[]` registry + `adapterFor(url): SiteAdapter | null`.
- **Create** `src/adapters/fourchan.ts` — `fourchanAdapter: SiteAdapter`, a thin object wiring the *existing* `detectPage`, `scanDocument`, `scanThreadList`, `isAllowedMediaHost`, `parseMediaUrl` (all unmoved, unmodified) into the adapter shape, plus `id: 'fourchan'`.
- **Create** `src/adapters/archiveofsins.ts` — `archiveofsinsAdapter: SiteAdapter`: `matches`, `detectPage`, `scan` (new DOM scanner for the FoolFuuka markup above), `allowedMediaHosts`, `parseMediaUrl`. No `threadApiUrl` (API is out of scope — robots.txt).
- **Modify** `src/content/index.ts` — resolve the adapter via `adapterFor(location)` instead of importing `detectPage`/`scanDocument` directly; bail out (no-op) if no adapter matches.
- **Modify** `src/background/download-manager.ts` (`buildTargetPath` call site is in `shared/filename-utils.ts`) — see next line.
- **Modify** `src/shared/filename-utils.ts` — `buildTargetPath` inserts `sanitizeSegment(item.site, '_')` ahead of board/thread when `organize !== 'flat'`.
- **Modify** `src/background/service-worker.ts` — new message handlers: `REQUEST_SITE_PERMISSION` (calls `chrome.permissions.request` + `chrome.scripting.registerContentScripts`), `SITE_PERMISSION_STATUS`.
- **Modify** `public/manifest.json` — add `optional_host_permissions: ["https://archiveofsins.com/*"]`, add `"scripting"` permission, remove archive's content script from the static `content_scripts` list (it's registered dynamically).
- **Modify** `src/options/Settings.tsx` — "Enable on archive site" button + explanatory copy; reflects current grant status.
- **Modify** `src/media-manager/MediaManager.tsx`, `src/media-manager/ThreadsPanel.tsx` — gate the "Add missing files from 4chan API" button and thread-list API-scan panel to `scan.page.site === 'fourchan'`.
- **Create** `tests/fixtures/archive-thread.html`, `tests/fixtures/archive-board.html`, `tests/fixtures/archive-changed-layout.html` — real, trimmed, script-stripped captures built from the Ground Truth markup above (replacing the synthetic `archive-tests/fixtures/*` set, which is not used).
- **Create** `tests/archive-media-detection.test.ts` — unit tests for the archive URL parser.
- **Create** `tests/archive-thread-scanner-page.test.ts` — unit tests for `detectPage`/`matches`.
- **Modify** `tests/dom/run-dom-tests.mjs` — add the archive Playwright DOM cases.
- **Modify** `tests/dom/e2e.mjs` — add host-resolver-rules for `archiveofsins.com`, scan/download/one-failure/permission-gated-activation cases.
- **Modify** `README.md` — "Supported sites" section, new permission explained.

---

### Task 1: `site` field plumbing + `mediaId`/`parseFileSize` extensions

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/media-detection.ts`
- Modify: `src/background/thread-scanner.ts` (`itemFromApiPost` passes `site: 'fourchan'`), `src/content/media-scanner.ts` (`scanDocument` output items get `site: 'fourchan'`), `src/background/download-manager.ts` (`historyFromItem`/`manifestsForBatch` carry `site` through)
- Modify: `src/shared/filename-utils.ts` (`buildTargetPath`)
- Test: `tests/media-detection.test.ts`, `tests/filename-utils.test.ts`, `tests/queue-manager.test.ts`, `tests/planner-storage.test.ts` (update existing path/id assertions to include the `fourchan` site segment — this is the one intentional behavior change)

**Interfaces:**
- Produces: `MediaItem.site: string`, `PageInfo.site: string`, `QueueItem.site: string`, `HistoryRecord.site: string`; `mediaId(site: string, board: string, tim: string): string` (was `mediaId(board, tim)`); `parseFileSize` now also matches `KiB|MiB|GiB`.

- [ ] **Step 1: Update failing/changed tests first** — in `tests/media-detection.test.ts`, change existing `mediaId('g','123')`-style calls to `mediaId('fourchan','g','123')` and assert the new `${site}:${board}:${tim}` format; add one case for `parseFileSize('675KiB')` → `690972` (binary KiB).
- [ ] **Step 2: Run** `npm test` — expect failures only in the tests just touched (compile errors elsewhere are expected until Step 3).
- [ ] **Step 3: Implement.** Add `site: string` to the four interfaces in `types.ts`. Change `mediaId` signature and its one call site in `itemFromApiPost`/`scanDocument`'s item construction to pass `'fourchan'` as `site`. In `filename-utils.ts`, change the `dirParts.push(...)` line in `buildTargetPath` to push `sanitizeSegment(item.site, '_')` before `item.board`. Extend `parseFileSize`'s regex to `/([\d.,]+)\s*(B|KB|KiB|MB|MiB|GB|GiB)\b/i` and its unit map to alias `KiB→KB`, `MiB→MB`, `GiB→GB` multipliers.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — fix every remaining compile error by threading `site: 'fourchan'` through call sites (`content/index.ts`'s item construction, `background/service-worker.ts` wherever a bare `MediaItem`/`QueueItem`/`HistoryRecord` literal is built). Expected: PASS.
- [ ] **Step 5: Run** `npm run test:dom` — update any fixture-path assertions in `tests/dom/*` that hardcoded the old `<board>/<thread>/...` layout to `fourchan/<board>/<thread>/...`. Expected: PASS.
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: thread a site id through MediaItem/PageInfo/QueueItem/HistoryRecord and download paths"`

---

### Task 2: `SiteAdapter` interface + `fourchan` wrapper adapter

**Files:**
- Create: `src/shared/site-adapter.ts`
- Create: `src/adapters/fourchan.ts`
- Test: `tests/fourchan-adapter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface SiteAdapter {
    id: string;
    matches(url: URL): boolean;
    detectPage(url: URL, title: string): PageInfo;
    scan(root: ParentNode, ctx: ScanContext, opts: ScanOptions): Promise<ScanResult>;
    allowedMediaHosts(host: string): boolean;
    parseMediaUrl(raw: string, base?: string): ParsedMediaUrl | null;
  }
  function adapterFor(url: URL): SiteAdapter | null;
  const ADAPTERS: SiteAdapter[];
  ```
  (`ScanContext`/`ScanOptions`/`ScanResult`/`ParsedMediaUrl` are the existing types from `content/media-scanner.ts` / `shared/media-detection.ts` — reused, not redefined.)
- Consumes: existing `detectPage` (`content/page-detector.ts`), `scanDocument` (`content/media-scanner.ts`), `isAllowedMediaHost`/`parseMediaUrl` (`shared/media-detection.ts`) — unmodified.

- [ ] **Step 1: Write the failing test** in `tests/fourchan-adapter.test.ts`: `fourchanAdapter.matches(new URL('https://boards.4chan.org/g/'))` → `true`; `fourchanAdapter.matches(new URL('https://archiveofsins.com/h/'))` → `false`; `fourchanAdapter.detectPage(...)` returns the same shape `detectPage` already returns (reuse one existing fixture case from `thread-scanner-page.test.ts`).
- [ ] **Step 2: Run** `node --test tests/fourchan-adapter.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `site-adapter.ts` with the `SiteAdapter` interface and an `ADAPTERS`/`adapterFor` that will include `archiveofsinsAdapter` once Task 4 exists (import it there once written; for now the array holds only `fourchanAdapter`). Implement `adapters/fourchan.ts`: `matches = (u) => ['boards.4chan.org','boards.4channel.org'].includes(u.hostname.toLowerCase())`; `detectPage = (u, title) => detectPage({hostname:u.hostname, pathname:u.pathname, href:u.href}, title)`; `scan = scanDocument`; `allowedMediaHosts = isAllowedMediaHost`; `parseMediaUrl = parseMediaUrl`; `id = 'fourchan'`.
- [ ] **Step 4: Run** `node --test tests/fourchan-adapter.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: add SiteAdapter interface and fourchan adapter wrapper"`

---

### Task 3: Real archiveofsins fixtures

**Files:**
- Create: `tests/fixtures/archive-thread.html`, `tests/fixtures/archive-board.html`, `tests/fixtures/archive-changed-layout.html`
- Modify: `tests/fixtures/README.md` (document these as real, trimmed captures with a capture date, replacing the note about `archive-tests/fixtures/*` being synthetic/unused)

**Interfaces:** none (fixture data only; consumed by Tasks 4–5's tests).

- [ ] **Step 1:** Build `archive-thread.html` from the real markup pattern verified above: one OP (`article.thread`, image, real-shaped class list `doc_id_<n> post_is_op has_image`), one image reply, one text-only reply (no `has_image`), one reply with `has_image` but no `.post_file_filename` (removed-file case, inferred shape), one reply whose filename is long enough to show the `title`-vs-truncated-text split. Use placeholder board `h`, placeholder thread num, lorem-ipsum post text, no real usernames/content, no scripts. Include one `.gif`-named and one `.webm`-named file entry even though neither was observed live, so the extension's existing media-type classification is exercised — note in the README that these two are structurally extrapolated, not observed.
- [ ] **Step 2:** Build `archive-board.html` with 3 `article.thread` blocks (OP only, no replies), same per-post markup, to exercise the "list threads on this page" path.
- [ ] **Step 3:** Build `archive-changed-layout.html`: same content as `archive-thread.html` with all classes/ids stripped (generic `<div>`s), to exercise the adapter's fallback/warning path the same way `tests/fixtures/changed-layout.html` does for 4chan.
- [ ] **Step 4:** Update `tests/fixtures/README.md` with a row per new file and a "captured 2026-10-28 via live DOM inspection, trimmed" note.
- [ ] **Step 5: Commit** `git add tests/fixtures/archive-*.html tests/fixtures/README.md && git commit -m "test: add real archiveofsins.com DOM fixtures"`

---

### Task 4: `archiveofsins` adapter — URL parser + unit tests

**Files:**
- Create: `src/adapters/archiveofsins.ts` (parser/host-allowlist/detectPage parts only; `scan` stubbed to throw until Task 5)
- Test: `tests/archive-media-detection.test.ts`

**Interfaces:**
- Produces: `archiveofsinsAdapter.parseMediaUrl(raw, base?)`, `archiveofsinsAdapter.allowedMediaHosts(host)`, `archiveofsinsAdapter.detectPage(url, title)`, `archiveofsinsAdapter.matches(url)`.
- Consumes: `ParsedMediaUrl`, `PageInfo`, `MediaType`, `classifyExt` (reused from `shared/media-detection.ts`).

- [ ] **Step 1: Write failing tests** in `tests/archive-media-detection.test.ts`:
  ```ts
  test('parses a real full-size image URL', () => {
    const p = archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com/data/h/image/1792/17/1792171898073007.jpg');
    assert.deepEqual(p, { url: 'https://archiveofsins.com/data/h/image/1792/17/1792171898073007.jpg', host: 'archiveofsins.com', board: 'h', tim: '1792171898073007', ext: 'jpg', type: 'image', isThumb: false });
  });
  test('parses the matching thumbnail URL as isThumb', ...);
  test('rejects a different host', () => assert.equal(archiveofsinsAdapter.parseMediaUrl('https://evil.example/data/h/image/1792/17/1792171898073007.jpg'), null));
  test('rejects path traversal', () => assert.equal(archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com/data/h/image/../../etc/passwd'), null));
  test('rejects credentials in the URL', () => assert.equal(archiveofsinsAdapter.parseMediaUrl('https://user:pass@archiveofsins.com/data/h/image/1792/17/1792171898073007.jpg'), null));
  test('rejects a non-standard port', () => assert.equal(archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com:8443/data/h/image/1792/17/1792171898073007.jpg'), null));
  test('rejects an unsupported extension', () => assert.equal(archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com/data/h/image/1792/17/1792171898073007.exe'), null));
  test('detectPage: thread', () => assert.deepEqual(archiveofsinsAdapter.detectPage(new URL('https://archiveofsins.com/h/thread/8968486/'), 't'), { kind: 'thread', board: 'h', threadId: '8968486', url: '...', title: 't' }));
  test('detectPage: board index', ...);
  test('detectPage: unsupported (search page)', () => assert.equal(archiveofsinsAdapter.detectPage(new URL('https://archiveofsins.com/h/search/text/foo/'), 't').kind, 'unsupported'));
  ```
- [ ] **Step 2: Run** `node --test tests/archive-media-detection.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `src/adapters/archiveofsins.ts`:
  - `HOST = 'archiveofsins.com'`; `allowedMediaHosts = (h) => h.toLowerCase() === HOST`.
  - `MEDIA_RE = /^\/data\/([a-z0-9]{1,10})\/(image|thumb)\/(\d{4})(\d{2})\d*\/(\d+)(s)?\.([a-z0-9]{2,5})$/i` — validate the two timestamp-prefix path segments actually match the filename's own leading digits (reject if not, closing the traversal case structurally rather than just via `URL` normalization); reject non-`https`, any `username`/`password`, and any port other than `443`/absent, mirroring `shared/media-detection.ts`'s existing hardening.
  - `detectPage`: `THREAD = /^\/([a-z0-9]{1,10})\/thread\/(\d+)\/?$/i`, `BOARD = /^\/([a-z0-9]{1,10})\/(?:\d+\/)?$/i`; anything else (including `/search/`, `/gallery`) → `kind: 'unsupported'`.
  - `matches = (u) => u.hostname.toLowerCase() === HOST`.
  - `scan`: `throw new Error('not implemented')` for now (Task 5 fills this in).
  - Register `archiveofsinsAdapter` in `ADAPTERS` in `site-adapter.ts`.
- [ ] **Step 4: Run** `node --test tests/archive-media-detection.test.ts` — expect PASS.
- [ ] **Step 5: Run** `npm test` (full suite) — expect PASS, confirming no 4chan regression.
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: add archiveofsins URL parser, host allowlist and page detection"`

---

### Task 5: `archiveofsins` adapter — DOM scanner + Playwright fixture tests

**Files:**
- Modify: `src/adapters/archiveofsins.ts` (implement `scan`)
- Modify: `tests/dom/run-dom-tests.mjs`
- Test: new Playwright cases against `tests/fixtures/archive-thread.html`, `archive-board.html`, `archive-changed-layout.html`

**Interfaces:**
- Consumes: `archiveofsinsAdapter.parseMediaUrl`, `allowedMediaHosts` (Task 4); `MediaItem`, `IgnoredSummary`, `ScanContext`, `ScanOptions`, `ScanResult` (existing types).
- Produces: `archiveofsinsAdapter.scan(root, ctx, opts): Promise<ScanResult>` with the same chunking/cancel/progress contract as `scanDocument`.

- [ ] **Step 1: Write failing Playwright cases** in `tests/dom/run-dom-tests.mjs` (follow the existing pattern used for `thread.html`): load `archive-thread.html`, call the scanner, assert: the image/gif/webm posts yield 3 `MediaItem`s with `site: 'archiveofsins'`, correct `url`/`type`/`originalName` (untruncated, from `title`) /`size`/`width`/`height`; the removed-file post yields one `onIgnored('removed', ...)` call and no item; the text-only post yields nothing. Load `archive-board.html` and assert 3 threads are listed. Load `archive-changed-layout.html` and assert a non-empty `warning` string plus best-effort fallback extraction (mirroring the existing `changed-layout.html` 4chan case).
- [ ] **Step 2: Run** `npm run test:dom` — expect FAIL.
- [ ] **Step 3: Implement `scan`** in `archiveofsins.ts`: query `article.thread, article.post`; for each, read `.post_file_filename[title]` (fallback to its text if no `title` and text doesn't contain `(...)`), `.post_file_metadata` text split on the first comma into size/dims, `a.thread_image_link[href]` via `parseMediaUrl`; skip (no item) when no `.thread_image_box`/`.post_file` present; call `opts.onIgnored(href, 'removed', 'file removed from archive')` when `has_image` is set but no filename anchor exists. Reuse the same chunking/`shouldCancel`/`onProgress`/`onItems` contract `scanDocument` already implements (same loop shape, different per-post extraction). Thread listing: `article.thread[id]` → `{ id, teaser, thumbUrl }` for the board-index case.
- [ ] **Step 4: Run** `npm run test:dom` — expect PASS.
- [ ] **Step 5: Run full suite** `npm test && npm run test:dom` — expect PASS.
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: implement archiveofsins DOM scanner with removed-file and layout-fallback handling"`

---

### Task 6: Content-script routing via the adapter registry

**Files:**
- Modify: `src/content/index.ts`

**Interfaces:**
- Consumes: `adapterFor(url): SiteAdapter | null` (Task 2).

- [ ] **Step 1:** No new automated test (this is a thin routing change over code already covered by Tasks 1–5's unit tests and the existing `tests/dom/*` e2e); manual check deferred to Task 8's e2e run.
- [ ] **Step 2: Implement.** Replace the top-level `const page: PageInfo = detectPage(location, document.title)` and the `scanDocument`/`scanThreadList` imports with `const adapter = adapterFor(new URL(location.href)); if (!adapter) return;` then `const page = adapter.detectPage(new URL(location.href), document.title);` and use `adapter.scan(...)` / (for thread listing) keep calling the existing `scanThreadList` only when `adapter.id === 'fourchan'` until an adapter-level thread-listing hook is worth generalizing (YAGNI for a single non-4chan adapter that only needs board-index listing, which `archiveofsins.ts`'s `scan` already produces via its own thread-summary branch from Task 5 — wire that result into `threads()` instead of calling `scanThreadList` when `adapter.id !== 'fourchan'`).
- [ ] **Step 3: Run** `npm run typecheck && npm test && npm run test:dom` — expect PASS, no 4chan behavior change.
- [ ] **Step 4: Commit** `git add -A && git commit -m "feat: route content script scanning through the SiteAdapter registry"`

---

### Task 7: Optional permission flow + dynamic content-script registration

**Files:**
- Modify: `public/manifest.json`, `src/background/service-worker.ts`, `src/shared/messaging.ts`, `src/options/Settings.tsx`
- Test: `tests/permission-flow.test.ts` (logic-only; the actual `chrome.permissions`/`chrome.scripting` calls are mocked the same way `tests/queue-manager.test.ts` mocks `chrome.downloads`)

**Interfaces:**
- Produces: `Msg` gains `{ type: 'REQUEST_SITE_PERMISSION'; site: 'archiveofsins' }` → background calls `chrome.permissions.request({ origins: ['https://archiveofsins.com/*'] })`, and on success `chrome.scripting.registerContentScripts([{ id: 'archiveofsins', matches: ['https://archiveofsins.com/*'], js: ['content.js'], runAt: 'document_idle' }])`; a `hasSitePermission(site)` helper backed by `chrome.permissions.contains`.

- [ ] **Step 1: Write the failing test** in `tests/permission-flow.test.ts`: given a mock `chrome.permissions.request` resolving `true` and a mock `chrome.scripting.registerContentScripts`, calling the handler registers exactly one content script for `https://archiveofsins.com/*`; given `request` resolving `false`, no registration call is made.
- [ ] **Step 2: Run** `node --test tests/permission-flow.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
  - `public/manifest.json`: add `"optional_host_permissions": ["https://archiveofsins.com/*"]`; add `"scripting"` to `permissions`; leave `content_scripts` as the static 4chan-only entry (archive registers dynamically).
  - `service-worker.ts`: handle `REQUEST_SITE_PERMISSION` — must be called from a UI click (popup/options), never on its own; `await chrome.permissions.request(...)`, then register the script on success; respond `{ ok: boolean }`.
  - `Settings.tsx`: "Enable on archive site" button calling `send({ type: 'REQUEST_SITE_PERMISSION', site: 'archiveofsins' })`, plus one sentence explaining why (scan/download media from archiveofsins.com, same local-only behavior as 4chan, no analytics).
- [ ] **Step 4: Run** `node --test tests/permission-flow.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: request archiveofsins.com access via optional permissions and register its content script dynamically"`

---

### Task 8: Gate 4chan-only UI, extend e2e harness, README

**Files:**
- Modify: `src/media-manager/MediaManager.tsx`, `src/media-manager/ThreadsPanel.tsx`
- Modify: `tests/dom/e2e.mjs` (host-resolver-rules + new scenarios), `tests/dom/e2e-large.mjs` if it also assumes single-site fixtures
- Modify: `README.md`

**Interfaces:** none new; consumes `scan.page.site` (Task 1).

- [ ] **Step 1:** In `MediaManager.tsx`, change the "Add missing files from 4chan API" button's guard from `scan.page.kind === 'thread' && scan.page.board && scan.page.threadId` to additionally require `scan.page.site === 'fourchan'`. Same gate in `ThreadsPanel.tsx`'s board-level API-scan affordance.
- [ ] **Step 2:** Extend `tests/dom/e2e.mjs`: add `--host-resolver-rules` entries mapping `archiveofsins.com` to the local HTTPS test server (same origin serves both page and media, per Ground Truth — simpler than the spec's original two-host assumption); add scenarios: (a) grant the optional permission via the Settings page button and confirm the content script then runs on an archive thread page served locally, (b) scan a thread fixture and confirm the expected file count/download, (c) one post whose file 404s from the local server and confirm it's reported as failed, not silently dropped.
- [ ] **Step 3: Run** `npm run test:e2e` — expect PASS. If the permission-grant step can't be driven headlessly through `chrome://extensions` in Playwright, say so explicitly in the plan's final report rather than claiming it passed.
- [ ] **Step 4:** Update `README.md`: new "Supported sites" section listing 4chan (built-in) and archiveofsins.com (opt-in, thread + board pages only, no search/gallery, no API-backed "add missing files" — explain the robots.txt reason); update the Permissions section to mention the optional host permission and `scripting`.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: gate 4chan-only UI by site, extend e2e harness for archiveofsins, document supported sites"`

---

## Deliverables / what to report back

- Diff summary across all 8 tasks.
- Full `npm test`, `npm run test:dom`, `npm run test:e2e` output.
- Explicit list of what could not be verified: live GIF/WebM/removed-file markup (Ground Truth note), and whether Playwright can drive the `chrome.permissions.request` gesture headlessly (Task 8, Step 3) — if not, say so and describe what was tested manually instead.
- Confirmation that archiveofsins.com never appears in `host_permissions`, only `optional_host_permissions`.
