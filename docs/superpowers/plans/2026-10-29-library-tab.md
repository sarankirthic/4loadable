# Library Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Library" tab to the media manager that browses the actual download directory in-browser (folder tree, thumbnails, preview, reveal-in-OS), backed by two interchangeable data sources.

**Architecture:** One `LibrarySource` interface with two implementations — `browser-records` (built from `chrome.downloads.search` + our `history` store, needs no new permission) and `folder` (File System Access API, read-only, user-granted). The existing `VirtualGrid`, `MediaManager` tab shell, dark/light CSS variables, and `PreviewModal`'s modal chrome are reused; new pure logic (tree building, manifest parsing, permission state, thumbnail concurrency) is unit-tested with fakes, and a Playwright DOM test drives the real React component against a faked source.

**Tech Stack:** TypeScript, React 18, esbuild, node:test, Playwright (existing stack — no new dependencies).

**Spec:** the task description pasted by the user in this conversation (reproduced in full in the session; not a separate file).

## Global Constraints

- No new npm dependencies.
- No new manifest permissions. `chrome.downloads.search`/`.show`/`.showDefaultFolder` are already covered by the existing `"downloads"` permission; the File System Access API needs no manifest entry at all (user-gesture gated web API). If a task implementer finds a case needing one, stop and flag it instead of adding it.
- Read-only: the `folder` source never writes, renames, or deletes. Never execute/navigate to a file; only `blob:` object URLs, always revoked.
- Treat filenames and paths as untrusted: no path joining from user-controlled text, ignore any entry named `..` or containing `/`/`\`.
- Keep existing dark/light theming via the CSS variables already in `src/ui/ui.css`; no new colors invented.
- `showDirectoryPicker` cannot be driven in headless Chromium — never claim that path was tested; it gets a manual checklist instead.
- Cache folder listings in memory for the session only; never persist file contents or thumbnails.

## Review Focus

- Untrusted entry names containing `..` or a path separator must be dropped by the `folder` source, never joined into a path — covered in Task 5's sanitization test.
- `showDirectoryPicker === undefined` (Firefox) must hide the folder option with an explanation, never throw — covered by Task 3's `classifyPermission('unsupported', …)` test and called out again in the manual checklist.
- A malformed or oversized `manifest.json` must not crash the panel or load unbounded text into memory — covered in Task 2's parser tests (malformed, oversized).
- Libraries of 50,000+ files must not be scanned into one in-memory array or block the UI thread — covered by Task 5's large-fixture + abort tests and Task 8's DOM virtualization assertion.
- Every thumbnail object URL created while scrolling must be revoked when the card leaves view or the panel unmounts — covered by Task 8's `createObjectURL`/`revokeObjectURL` count assertion (no unit-testable surface for this; it's a DOM-only concern).

---

### Task 1: Library types + tree/sort/filter utilities

**Files:**
- Create: `src/shared/library-types.ts`
- Create: `src/shared/library-tree.ts`
- Test: `tests/library-tree.test.ts`

**Interfaces:**
- Produces (`library-types.ts`):
  ```ts
  export type LibrarySourceId = 'browser-records' | 'folder';
  export interface LibraryEntry {
    kind: 'folder' | 'file';
    name: string;                 // display only, already sanitized
    path: string[];                // segments from the library root
    mediaType?: MediaType;         // files only
    size?: number;
    modifiedAt?: number;
    downloadId?: number;           // browser-records only
    missing?: boolean;             // browser-records only: download.exists === false
    fileCount?: number;            // folders only, filled as children resolve
    totalSize?: number;            // folders only
    sourceHandle?: unknown;        // opaque, passed back into thumbnail()/open()/revealInOS()
  }
  export interface LibrarySource {
    readonly id: LibrarySourceId;
    list(path: string[], signal: AbortSignal): AsyncIterable<LibraryEntry>;
    thumbnail(entry: LibraryEntry): Promise<string | null>;
    open(entry: LibraryEntry): Promise<Blob | null>;
    revealInOS?(entry: LibraryEntry): Promise<void>;
  }
  ```
- Produces (`library-tree.ts`), consumed by Tasks 4, 7:
  ```ts
  export interface FlatLeaf { path: string[]; size?: number; missing?: boolean; mediaType?: MediaType; downloadId?: number; modifiedAt?: number }
  export function buildTree(leaves: FlatLeaf[]): LibraryEntry[]; // one level: the root's immediate children, folders carry aggregated fileCount/totalSize
  export function childrenAt(leaves: FlatLeaf[], path: string[]): LibraryEntry[]; // same aggregation, scoped to one directory level
  export type SortKey = 'name' | 'date' | 'size';
  export function sortEntries(entries: LibraryEntry[], key: SortKey, dir: 'asc' | 'desc'): LibraryEntry[]; // folders always sort before files
  export function filterEntries(entries: LibraryEntry[], opts: { query?: string; types?: MediaType[] }): LibraryEntry[]; // query matches `name`, case-insensitive substring
  ```

- [ ] **Step 1: Write failing tests** in `tests/library-tree.test.ts`: `childrenAt` groups a flat leaf list into one folder level with correct `fileCount`/`totalSize`; a leaf with `missing: true` propagates `missing` onto its file entry; `sortEntries` puts folders first then sorts by name/date/size in both directions; `filterEntries` matches a case-insensitive substring and narrows by `types`.
- [ ] **Step 2: Run** `npm test -- tests/library-tree.test.ts` (or `tsx --test tests/library-tree.test.ts`) — expect FAIL (module not found).
- [ ] **Step 3: Implement** `library-types.ts` and `library-tree.ts` per the signatures above. `buildTree`/`childrenAt` share one grouping helper (don't duplicate the aggregation loop).
- [ ] **Step 4: Run** the same test — expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 2: manifest.json parsing

**Files:**
- Create: `src/shared/library-manifest.ts`
- Test: `tests/library-manifest.test.ts`

**Interfaces:**
- Consumes: the JSON shape `manifest-export.ts`/`download-manager.ts`'s `manifestsForBatch` already write (`{ generatedAt, files: [{ sourceUrl, originalFilename, mediaType, board, threadId, postNumber, savedPath, status, error?, updatedAt }] }`).
- Produces, consumed by Task 7:
  ```ts
  export const MANIFEST_MAX_BYTES = 1_000_000;
  export interface ManifestFileRecord { sourceUrl: string; originalFilename: string; postNumber: string }
  export function parseThreadManifest(text: string): { files: ManifestFileRecord[] } | null; // null on malformed JSON, wrong shape, or text.length > MANIFEST_MAX_BYTES
  export function findManifestRecord(manifest: { files: ManifestFileRecord[] } | null, originalFilename: string): ManifestFileRecord | undefined;
  ```

- [ ] **Step 1: Write failing tests**: valid manifest JSON (matching the real shape) returns the parsed `files` array; malformed JSON (`'{not json'`) returns `null`; oversized text (length > `MANIFEST_MAX_BYTES`) returns `null` without calling `JSON.parse`; a validly-parsed-but-wrong-shape value (e.g. `'{"files": "nope"}'`) returns `null`; `findManifestRecord` finds the record whose `originalFilename` matches and returns `undefined` for no match or a `null` manifest.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Check `text.length` before `JSON.parse`; wrap `JSON.parse` in try/catch; validate `Array.isArray(parsed.files)` before returning.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 3: Folder permission state machine + handle store

**Files:**
- Create: `src/shared/library-folder-store.ts`
- Test: `tests/library-folder-permission.test.ts`

**Interfaces:**
- Produces, consumed by Tasks 5, 7:
  ```ts
  export type FolderPermissionState = 'unsupported' | 'disconnected' | 'granted' | 'needs-reconnect' | 'denied';
  export function classifyPermission(opts: { supported: boolean; hasHandle: boolean; queryResult?: 'granted' | 'prompt' | 'denied' }): FolderPermissionState;
  export function isLikelyDownloadsRoot(name: string): boolean; // case-insensitive name === 'downloads'
  export interface HandleStore<H> { get(): Promise<H | null>; set(h: H): Promise<void>; clear(): Promise<void> }
  export function indexedDBHandleStore<H>(dbName?: string): HandleStore<H>; // thin real IndexedDB wrapper, not unit-tested beyond a smoke test behind an `if (typeof indexedDB !== 'undefined')` guard
  ```

**Interfaces consumed:** none beyond browser globals.

- [ ] **Step 1: Write failing tests**: `classifyPermission` returns `'unsupported'` whenever `supported: false` regardless of other fields; `'disconnected'` when supported but `hasHandle: false`; `'granted'`/`'needs-reconnect'`/`'denied'` map 1:1 from `queryResult` of `'granted'/'prompt'/'denied'` when `hasHandle: true`; `isLikelyDownloadsRoot` is true for `'Downloads'`, `'downloads'`, false for `'4lodable'` or `'Downloads (1)'`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the pure functions. `indexedDBHandleStore` is a thin wrapper (one object store, one fixed key) — write it but don't test it beyond what Step 1 covers; Task 5/7's fakes substitute a `HandleStore` in-memory implementation instead of touching real IndexedDB in tests.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 4: `browser-records` LibrarySource

**Files:**
- Create: `src/shared/library-source-browser.ts`
- Test: `tests/library-source-browser.test.ts`

**Interfaces:**
- Consumes: `LibraryEntry`/`LibrarySource` (Task 1), `childrenAt`/`FlatLeaf` (Task 1), `HistoryRecord` (`src/shared/types.ts`), `loadHistory` (`src/shared/storage.ts`).
- Produces:
  ```ts
  export interface BrowserRecordsDeps {
    search(query: { filenameRegex?: string; state?: 'complete' }): Promise<Array<{ id: number; filename: string; exists?: boolean; totalBytes?: number; startTime?: string }>>;
    loadHistory(): Promise<Record<string, HistoryRecord>>;
    baseFolder: string; // sanitizeFolderPath(settings.rootFolder + '/' + settings.subfolder).join('/')
  }
  export function createBrowserRecordsSource(deps: BrowserRecordsDeps): LibrarySource;
  ```

- [ ] **Step 1: Write failing tests** with a fake `search` returning items under and outside `baseFolder`, some with `exists: false`: `list([], signal)` yields only the top-level folder/file entries under `baseFolder`; a deeper `list(['h','8968486'], signal)` yields that thread's children; an item with `exists: false` yields a file entry with `missing: true`; an item whose `filename` doesn't start with `baseFolder` is excluded entirely; `thumbnail()`/`open()` return `null` for a folder entry (no in-page handle to a browser download's bytes beyond its own URL — out of scope, `open()` returns `null`, UI falls back to the file's recorded `url`/history `sourceUrl` if present, otherwise shows "preview unavailable").
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** `createBrowserRecordsSource` calls `deps.search` once per `list()` invocation (no cross-call cache here — Task 7's UI layer owns the session cache per spec), maps each `DownloadItem` into a `FlatLeaf` (path = segments after `baseFolder`), reuses `childrenAt` from Task 1 for the grouping/aggregation, and sets `missing: item.exists === false`. `revealInOS` is present and calls through to a `deps.show?(downloadId)` style callback — thread this through as an extra optional field on `BrowserRecordsDeps` (`show?(id: number): Promise<void>`) so Task 7 can wire the real `chrome.downloads.show`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 5: `folder` LibrarySource (File System Access API)

**Files:**
- Create: `src/shared/library-source-folder.ts`
- Test: `tests/library-source-folder.test.ts`

**Interfaces:**
- Consumes: `LibraryEntry`/`LibrarySource` (Task 1), `isLikelyDownloadsRoot` (Task 3, used by the UI layer in Task 7 — not inside this file).
- Produces:
  ```ts
  export interface DirHandleLike { readonly kind: 'directory'; readonly name: string; entries(): AsyncIterable<[string, DirHandleLike | FileHandleLike]> }
  export interface FileHandleLike { readonly kind: 'file'; readonly name: string; getFile(): Promise<Blob & { name: string; lastModified: number }> }
  export function createFolderSource(root: DirHandleLike): LibrarySource;
  ```
  `thumbnail()` returns an object URL for image entries only (reads the file, wraps in `URL.createObjectURL`); returns `null` for video/folder (the UI renders `<video preload="metadata">` directly from `open()`'s blob for video posters, per spec). `open()` returns the file as a `Blob` for any file entry. `revealInOS` is `undefined` (no OS path is reachable from a bare FS Access handle).

- [ ] **Step 1: Write failing tests** using an in-memory fake `DirHandleLike`/`FileHandleLike` (plain objects + a `Map`-backed `entries()` async generator): nested folders (`list(['a','b'], signal)` walks two levels and yields `b`'s children); a name containing `..` or `/` is skipped, not yielded and not path-joined; thousands of files (build a fake directory with 5,000 file entries) — `list` yields them incrementally (assert the async iterator yields before fully draining, e.g. collect only the first 10 via `for await` + `break` and confirm no error/hang); an entry whose `entries()` throws partway through — `list` surfaces the entries already yielded and stops cleanly (doesn't throw out of the whole generator before any `yield`, and the caller's `for await` can catch the eventual throw); an aborted scan — pass an already-aborted `AbortSignal` and confirm `list` yields zero entries.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** `list` is an `async function*` that checks `signal.aborted` before each `yield` and returns early if set; for each `[name, handle]` from `entries()`, skip when `name === '..' || name.includes('/') || name.includes('\\')` before doing anything else with it.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 6: Thumbnail concurrency queue

**Files:**
- Create: `src/shared/library-thumbnails.ts`
- Test: `tests/library-thumbnails.test.ts`

**Interfaces:**
- Produces, consumed by Task 7:
  ```ts
  export function createThumbnailQueue(concurrency = 4): {
    schedule<T>(job: () => Promise<T>): Promise<T>;
    cancelAll(): void; // rejects every job still pending (not yet started) with a distinguishable error; in-flight jobs are left to finish
  };
  ```

- [ ] **Step 1: Write failing tests**: scheduling 10 jobs that each resolve after a tick, with `concurrency = 3`, never has more than 3 running at once (track via a counter incremented/decremented inside each job); all 10 eventually resolve with their own values in the right place; `cancelAll()` rejects jobs that hadn't started yet.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** as a small FIFO queue with an active-count gate.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 7: Library tab UI

**Files:**
- Create: `src/media-manager/LibraryPanel.tsx` (breadcrumb, source switch/connect/reconnect, search/filter/sort toolbar, state messages, wires `VirtualGrid`)
- Create: `src/media-manager/LibraryTree.tsx` (left-side folder tree, lazy per-node expansion via `source.list`)
- Create: `src/media-manager/LibraryPreviewModal.tsx` (image/video preview from `source.open()`, prev/next, path + size, reveal-in-OS button)
- Modify: `src/media-manager/MediaManager.tsx` — add `'library'` to the `Tab` union and the tab button list; render `<LibraryPanel settings={settings} notify={notify} />` when `tab === 'library'`
- Modify: `src/ui/ui.css` — add `.tree`, `.treerow`, `.crumbs` rules using only existing CSS variables (`--panel`, `--line`, `--accent`, `--muted`, etc.)

**Interfaces:**
- Consumes: `LibrarySource`/`LibraryEntry` (Task 1), `sortEntries`/`filterEntries` (Task 1), `parseThreadManifest`/`findManifestRecord` (Task 2), `classifyPermission`/`isLikelyDownloadsRoot`/`HandleStore`/`indexedDBHandleStore` (Task 3), `createBrowserRecordsSource` (Task 4), `createFolderSource` (Task 5), `createThumbnailQueue` (Task 6), `VirtualGrid` (`src/ui/VirtualGrid.tsx`), `useElementSize`/`useToast` pattern (`src/ui/hooks.ts`).
- No new message types needed: reveal-in-OS for `browser-records` calls `chrome.downloads.show(downloadId)`/`chrome.downloads.showDefaultFolder()` directly from the manager page (same privilege level the manager already runs at — no background round-trip required).

Behavior to implement (no further interface decisions beyond this point are the implementer's to make):
- Default source: `folder` if a handle is stored and its permission state is `'granted'`, else `browser-records`. A toggle switches between them when both are usable (hide the `folder` option entirely when `typeof window.showDirectoryPicker !== 'function'`, with inline copy explaining Firefox isn't supported).
- "Choose library folder" button calls `showDirectoryPicker({ mode: 'read' })` on click; on success, if `isLikelyDownloadsRoot(handle.name)`, discard the handle and show "Chrome won't let extensions open the Downloads folder itself — pick the `<rootFolder>` subfolder inside it instead" (substitute the live `settings.rootFolder`); otherwise store the handle via `indexedDBHandleStore().set(handle)` and switch to it.
- On later visits, call `handle.queryPermission({ mode: 'read' })`; only call `requestPermission` from a "Reconnect" button click, never automatically.
- Right pane: breadcrumb trail built from the current `path: string[]`; filename search box and type filter feed `filterEntries`; a sort control (name/date/size, asc/desc) feeds `sortEntries`; results render through `VirtualGrid` reusing the existing `.card`/`.listrow` styling, with a lazy `<img>`/`<video poster>` driven by the Task 6 queue and `IntersectionObserver`-gated visibility, revoking each entry's object URL in a cleanup effect when it scrolls out or the component unmounts.
- Directory scans use an `AbortController` per navigation; show "`N` files found" from a running count and a Cancel button that aborts it; never block the main thread (the `list()` async iterator already yields incrementally — consume it with `for await` and flush batches to state, e.g. every 200 entries or every animation frame).
- When the current folder is a thread folder (last path segment matches a thread id pattern, or simply: try reading `manifest.json` as a sibling of the listed files) and `manifest.json` exists, read it through the active source's `open()` with a size check (`blob.size > MANIFEST_MAX_BYTES` skips without reading) and `parseThreadManifest`, then show source URL/post number/original filename for the currently previewed file via `findManifestRecord`. Render all of it through React text interpolation (JSX `{}`), never `dangerouslySetInnerHTML`.
- Empty/error states, each a plain-language `<div className="empty">` or `<div className="notice">`: not connected, permission lapsed (needs-reconnect/denied), folder empty, source unsupported (Firefox), files missing (browser-records `missing: true`), and read errors (a `list()`/`open()` rejection caught and shown without a stack trace).

- [ ] **Step 1: Wire the tab.** Add `'library'` to `MediaManager.tsx`'s `Tab` type and tab bar; render a placeholder `<LibraryPanel>` import. Confirm `npm run typecheck` passes with a minimal `LibraryPanel` stub before building out its internals (keeps the integration diff isolated from the component's own logic).
- [ ] **Step 2: Implement `LibraryPanel.tsx`, `LibraryTree.tsx`, `LibraryPreviewModal.tsx`** per the behavior above, composing Tasks 1–6's exports. This is UI code with no fresh unit-testable logic of its own (all the logic it calls was tested in Tasks 1–6) — its correctness is checked by Task 8's DOM test, not a new unit test here.
- [ ] **Step 3: Run** `npm run typecheck` and `npm test` — expect PASS (no regressions in the existing suite).
- [ ] **Step 4: Manually smoke-check in the built extension** (`npm run build`, load `dist/` unpacked) that the Media/Threads/Queue/History tabs still render correctly and the new Library tab appears without a console error — this is the one pre-Task-8 checkpoint, not a substitute for Task 8's automated test.
- [ ] **Step 5: Commit.**

---

### Task 8: Playwright DOM test for the Library tab

**Files:**
- Create: `tests/dom/library-dom.mjs`
- Modify: `package.json` — `"test:dom": "node tests/dom/run-dom-tests.mjs && node tests/dom/library-dom.mjs"`

**Interfaces:**
- Consumes: `LibraryPanel` (Task 7), a fake `LibrarySource` built inline in the test (implements `list`/`thumbnail`/`open` over an in-memory 5,000-entry tree; no real `chrome.*` or File System Access API involved).

- [ ] **Step 1: Write the test**, following `run-dom-tests.mjs`'s pattern (esbuild-bundle a small stdin entry that mounts `LibraryPanel` with the fake source via `ReactDOM.createRoot`, `page.setContent`/`page.addScriptTag`, then drive with Playwright):
  - the tree renders at least the root-level folder names from the fake source;
  - with 5,000 file entries in one folder, the number of rendered `.card`/`.listrow` DOM nodes stays near a screenful (assert it's under some small bound, e.g. `< 100`, not `5000`) — proves virtualization;
  - scrolling the grid causes new thumbnails to appear only for now-visible cards (assert a thumbnail `<img src>`/`<video poster>` is empty/absent for an off-screen card and present after scrolling it into view);
  - instrument `URL.createObjectURL`/`URL.revokeObjectURL` on the page (wrap them before mounting) and assert the revoke count catches up to the create count after scrolling away from a batch of cards;
  - clicking a card opens `LibraryPreviewModal` (assert the preview dialog is present) and clicking "Close" (or pressing Escape) removes it.
- [ ] **Step 2: Run** `node tests/dom/library-dom.mjs` — expect FAIL (file/behavior doesn't exist yet if run before Task 7, or informative failures if logic is wrong).
- [ ] **Step 3: Fix** whatever Task 7 behavior doesn't yet satisfy the assertions (this task is allowed to send small fixes back into Task 7's files — the DOM test is the acceptance gate for that task's UI work).
- [ ] **Step 4: Run** `npm run test:dom` — expect PASS, including the pre-existing scanner DOM tests.
- [ ] **Step 5: Commit.**

---

### Task 9: Docs + final verification

**Files:**
- Modify: `README.md` — describe the Library tab (two sources, read-only, local-only), note no new permissions were needed.
- Modify: `src/options/Settings.tsx` — one added sentence in the existing `<section><h2>Privacy</h2>` block covering the optional folder access (user-chosen, read-only, on-device, never written to).
- Modify: `PRIVACY_POLICY.md` — same disclosure as Settings, in whatever section already covers permissions/data handling.

- [ ] **Step 1: Update `README.md`, `Settings.tsx`, `PRIVACY_POLICY.md`** with the read-only/local-only/optional-folder language above, matching each file's existing tone and section structure (don't restructure either doc, just add to it).
- [ ] **Step 2: Run the full suite** — `npm run typecheck && npm test && npm run test:dom` — and show the output. `npm run test:e2e` is out of scope for this feature (no page-scanning behavior changed) — skip it, note why.
- [ ] **Step 3: Write the manual test checklist** for real Chrome (post it to the user, not into a repo file unless they ask for one):
  - Click "Choose library folder", pick the base download folder (e.g. `4lodable`) → confirm it connects and the tree renders real downloaded files.
  - Try picking the actual OS Downloads folder → confirm the "pick the subfolder instead" message appears and nothing crashes.
  - Reload the manager page → confirm it reconnects without a picker prompt (permission `granted`), or shows "Reconnect" if the browser decided to re-ask.
  - Revoke the permission via `chrome://settings` or re-granting flow, reload → confirm the "needs-reconnect"/"denied" messaging appears and a click on "Reconnect" restores access.
  - Open a thread folder that has `manifest.json` → confirm source URL/post number/original filename show in preview.
  - Click "Reveal in OS" on a file known to the download history → confirm the OS file manager opens to it; on a folder-only file (no `downloadId`) → confirm it falls back to `showDefaultFolder()` or is hidden, whichever the implementation chose.
  - Point the folder at a directory with 10,000+ files → confirm the UI stays responsive and the progress counter updates, and Cancel actually stops it.
  - In Firefox (if available) → confirm the folder option is hidden with an explanation and `browser-records` still works.
  - State: only the folder-picker flow, the real permission prompts, and real Firefox behavior are unverified by automation — everything else (tree building, sort/filter, manifest parsing, permission state transitions, thumbnail concurrency, virtualization, object-URL revocation, preview open/close) is covered by Tasks 1–8's tests.
- [ ] **Step 4: Commit the docs changes** (code changes were already committed per-task).
