# 4loadable

A Manifest V3 browser extension that scans 4chan threads, boards and catalogs, lets you select images, GIFs and videos, and downloads them into organized folders through your browser's download manager. No server, no analytics, no ads.

## Supported sites
- **4chan** (`boards.4chan.org`, `boards.4channel.org`) — on by default.
- **archiveofsins.com**, a FoolFuuka-style 4chan archive — off by default. Turn it on from Settings → *Other sites* → *Enable on archiveofsins.com*; this triggers a one-time browser permission prompt (`chrome.permissions.request`), and only after you grant it does the extension's content script activate there. `archiveofsins.com` is **never** requested as a static permission, so installing or updating the extension never silently gains access to it. Supports thread and board pages: image/GIF/video detection, the same manager UI, and downloads laid out as `<root>/archiveofsins/<board>/<thread>/...`. The 4chan-only features (API cross-check against a thread's full file list, and the board-level "list every thread" API scan) are not available there, since archiveofsins has no equivalent public API — board pages are scanned directly from the page instead.

## Install and run

```bash
npm install            # install dependencies
npm run build          # production build -> dist/
npm run dev            # watch mode (rebuilds on change; reload the extension after)
npm test               # unit tests (Node's built-in test runner via tsx)
npm run test:dom       # scanner tests against HTML fixtures in real Chromium (needs playwright + Chromium)
npm run typecheck      # tsc --noEmit
npm run build:firefox  # -> dist-firefox/ (see Firefox notes)
```

A prebuilt `dist/` is included, so you can load it without building.

### Load in Chrome (or Edge, Brave)
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. Open a 4chan thread, pin the extension, and click its icon.

## Using it
- **Popup**: shows the board/thread, counts of images/GIFs/videos, **Scan page**, **Download all**, **Select media**, queue progress and recent activity.
- **Media manager** (popup → *Select media*): grid or list, lazy thumbnails, search (filename, `>>postnumber`), type filters, sort, select all / by type / invert / shift-click range, preview (images and video) with spacebar to toggle selection and arrow keys to navigate, selected count and estimated size, then **Download selected** or **Download all**. The *Queue* tab has pause, resume, cancel, retry and error details. *History* exports the manifest as JSON or CSV.
- **Missing files on a thread** *(4chan only)*: in the manager, *Add missing files from 4chan API* reads the thread's full file list from the public API (one request) and adds anything the page scan missed.
- **Board pages and catalogs** *(4chan only)*: the *Threads* tab lists threads. You choose which to scan, or explicitly list every thread on the board. Scanning uses 4chan's public JSON API at one request per second and can be cancelled. Nothing is crawled unless you start it. On archiveofsins.com board pages, media is scanned directly from the page instead — there is no equivalent API, so the *Threads* tab doesn't appear there.
- **In-page toolbar**: small collapsible bar (Scan page, Select visible, Download selected, Manager). Disable it in Settings.

Default save layout (inside your browser's Downloads folder):
```
4lodable/<site>/<board>/<thread>/{images,gifs,videos}/<original filename>
4lodable/<site>/<board>/<thread>/manifest.json
```
Layout, filename template (`{original} {server} {post} {thread} {board} {index} {type} {date}`), single-folder mode and duplicate handling are configurable.

## Browser limits you should know about
- Extensions can only save **inside the Downloads folder**. They cannot write to arbitrary paths. Turn on *Ask where to save* to use the browser's save dialog per file. A File System Access API folder-picker workflow is **not implemented**.
- "Keep both" relies on the browser's own renaming (`name (1).png`), so files are never silently overwritten. "Skip already downloaded" uses the extension's history, and re-downloads if the browser reports the earlier file was deleted.
- A file counts as **complete only when the browser reports it complete**.
- Sizes and dimensions come from what the page or API already shows. Original files are never fetched just to learn their size. "Check for deleted files" sends one HEAD request per file and only when you click it.

## Permissions
| Permission | Why |
|---|---|
| `downloads` | Save files and learn whether each finished |
| `storage` | Settings, queue, history, scan results |
| `alarms` | Wake the background worker so queues and retries survive it sleeping |
| `boards.4chan.org`, `boards.4channel.org` | Read posts on 4chan pages |
| `a.4cdn.org` | 4chan's public API, only when scanning threads |
| `i.4cdn.org` | Media host, used for optional availability checks |
| `scripting` | Lets the extension turn on its archiveofsins.com content script only after you grant the optional permission below |
| `archiveofsins.com` *(optional)* | Only requested when you click *Enable on archiveofsins.com* in Settings; lets the scanner read posts there |

No `tabs` or `activeTab`, and no static access to any site beyond 4chan and its API/media hosts. `archiveofsins.com` is requested at runtime via `chrome.permissions.request`, never listed in `host_permissions`. Downloads are allowed only from `i.4cdn.org` (and `isN.4chan.org` as a defensive allowance) and `archiveofsins.com`; edit `src/shared/media-detection.ts` / `src/adapters/archiveofsins.ts` if a site changes its media hosts.

## Privacy
Everything stays on your device. The only network traffic is to 4chan: the downloads you start, the public API when you scan threads, and optional HEAD checks. Nothing is sent to any other server.

## Troubleshooting
- **"Cannot reach this page"**: the tab was open before the extension was installed or reloaded. Reload the 4chan tab.
- **No media found**: wait for posts to load, then *Scan page*. If a banner says the layout looks different, 4chan's markup changed. Update the selectors in `src/content/media-scanner.ts` (all page-specific logic lives there and in `page-detector.ts`).
- **Download failed: file not found**: the file was deleted from 4chan. It is not retried.
- **Failed: path too long / invalid filename**: shorten the base folder or filename template.
- **Nothing starts**: check the queue isn't paused, and that your browser isn't blocking multiple automatic downloads (`chrome://settings/content/automaticDownloads`).
- **Storage quota exceeded**: history is capped at 20,000 records and trims itself. Export it, then *Clear history*.
- **Settings reset**: Settings page → *Reset to defaults*.

## Firefox
`npm run build:firefox` emits a manifest using `background.scripts` and a Gecko ID. **This has not been tested in Firefox.** Treat it as a starting point. Known unknowns: `storage.session` access from content scripts, the downloads API's filename handling, and the `alarms` cadence.

## Architecture
```
src/shared       types, URL validation + thumbnail→original, filename safety, storage, manifest export, filter/sort/selection logic
src/adapters     per-site SiteAdapter implementations (fourchan: thin wrapper; archiveofsins: FoolFuuka DOM scanner + URL parser)
src/content      page-detector, media-scanner (chunked, cancellable, MutationObserver), in-page toolbar — all routed through adapterFor(url)
src/background   queue-manager (persistent state machine, concurrency, retries), download-manager (planning, manifests, chrome.downloads port),
                 thread-scanner (rate-limited API), site-permissions (optional-permission grant + dynamic content-script registration), scan-store, service-worker
src/popup, src/media-manager, src/options   React UI (own virtualized grid, no UI dependencies)
tests            unit tests, HTML fixtures, DOM tests, and an end-to-end test
```
**Build tool:** the build uses esbuild directly (the bundler Vite itself uses) rather than Vite. For an extension with five independent entry points, this removes configuration and works offline. `npm run dev` is watch mode, not a dev server.

## Tested / not tested
Tested: 76 unit tests; 15 scanner tests against fixtures in Chromium (4chan + archiveofsins); `tests/dom/e2e.mjs` is written to also drive the archiveofsins.com optional-permission grant (a real click on the Settings button, so it exercises an actual user gesture, not a stubbed one), a fresh-navigation content-script activation, scan and download, and a check that the archiveofsins page never shows the 4chan-only "Add missing files from 4chan API" button. The e2e test needs a self-signed cert: `openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/e2e/k.pem -out /tmp/e2e/c.pem -days 2 -subj "/CN=localhost"`.

Not tested: real 4chan or real archiveofsins.com (markup for both is modeled on documented/captured structure and may drift), Firefox, Edge/Brave, the API thread-scan path end to end (unit-tested only), in-page toolbar actions, and interrupted downloads in a real browser (covered by unit tests with a fake downloads API). The archiveofsins.com e2e scenario above has been written but **not executed** in this environment — the sandbox used to build this feature blocks running `openssl` (needed to generate the test server's self-signed cert), so neither the original 4chan e2e test nor the new archiveofsins one could actually be run here; run `npm run test:e2e` yourself after generating the cert to verify, including whether Playwright's click can drive `chrome.permissions.request`'s user-gesture requirement headlessly.
