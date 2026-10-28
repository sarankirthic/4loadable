# 4loadable

A Manifest V3 browser extension that scans 4chan threads, boards and catalogs, lets you select images, GIFs and videos, and downloads them into organized folders through your browser's download manager. No server, no analytics, no ads.

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
- **Missing files on a thread**: in the manager, *Add missing files from 4chan API* reads the thread's full file list from the public API (one request) and adds anything the page scan missed.
- **Board pages and catalogs**: the *Threads* tab lists threads. You choose which to scan, or explicitly list every thread on the board. Scanning uses 4chan's public JSON API at one request per second and can be cancelled. Nothing is crawled unless you start it.
- **In-page toolbar**: small collapsible bar (Scan page, Select visible, Download selected, Manager). Disable it in Settings.

Default save layout (inside your browser's Downloads folder):
```
4lodable/<board>/<thread>/{images,gifs,videos}/<original filename>
4lodable/<board>/<thread>/manifest.json
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

No `tabs`, `activeTab` or `scripting`, and no access to other sites. Downloads are allowed only from `i.4cdn.org` (and `isN.4chan.org` as a defensive allowance; edit `src/shared/media-detection.ts` if 4chan changes media hosts).

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
src/content      page-detector, media-scanner (chunked, cancellable, MutationObserver), in-page toolbar
src/background   queue-manager (persistent state machine, concurrency, retries), download-manager (planning, manifests, chrome.downloads port),
                 thread-scanner (rate-limited API), scan-store, service-worker
src/popup, src/media-manager, src/options   React UI (own virtualized grid, no UI dependencies)
tests            unit tests, HTML fixtures, DOM tests, and an end-to-end test
```
**Build tool:** the build uses esbuild directly (the bundler Vite itself uses) rather than Vite. For an extension with five independent entry points, this removes configuration and works offline. `npm run dev` is watch mode, not a dev server.

## Tested / not tested
Tested: 55 unit tests; 10 scanner tests against fixtures in Chromium; an end-to-end run of the built extension in Chromium against a local stand-in for 4chan (scan, dynamic posts, download, 404 handling, retry, skip-duplicates, manifest, history). The e2e test needs a self-signed cert: `openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/e2e/k.pem -out /tmp/e2e/c.pem -days 2 -subj "/CN=localhost"`.

Not tested: real 4chan (markup is modeled on its documented structure and may differ, and 4chan X / other userscripts are untested), Firefox, Edge/Brave, the API thread-scan path end to end (unit-tested only), in-page toolbar actions, and interrupted downloads in a real browser (covered by unit tests with a fake downloads API).
