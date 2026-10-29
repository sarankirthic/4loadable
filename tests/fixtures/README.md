# Test fixtures

| File | Scenario |
|---|---|
| thread.html | 4chan thread: image, gif, webm, duplicate, untrusted host, inline quote copy |
| board.html | 4chan board index with 2 threads |
| catalog.html | 4chan catalog with teaser/replies |
| changed-layout.html | 4chan thread with classes/ids stripped, for the fallback path |
| ignored.html | Media-looking links the scanner should report as ignored (type/host/layout) |
| thread.json | 4chan `a.4cdn.org` thread API response |

## archiveofsins.com (real, captured 2026-10-28 via live DOM inspection, trimmed)

`archive-thread.html`, `archive-board.html` and `archive-changed-layout.html` are built from markup
verified live on archiveofsins.com (see `docs/superpowers/plans/2026-10-28-archiveofsins-adapter.md`
Ground Truth): `article.thread`/`article.post`, `thread_image_box`/`thread_image_link`/`post_image`,
and `post_file`/`post_file_filename`/`post_file_metadata`. Hosts, boards, thread/post numbers and post
text are placeholders; no real usernames or post content.

| File | Scenario |
|---|---|
| archive-thread.html | OP image, image reply with a long/truncated filename, text-only reply, a reply with `has_image` but no filename (removed-file case — **inferred**, not observed live), a `.gif` reply and a `.webm` reply (**structurally extrapolated**, neither was observed live) |
| archive-board.html | Board index with 3 OP-only threads, for the "list threads on this page" path |
| archive-changed-layout.html | Same content with all classes/ids stripped, for the adapter's fallback/warning path |

The synthetic fixtures previously in `archive-tests/fixtures/*` (see its own README) were never used by
any adapter or test and are superseded by the real captures above.
