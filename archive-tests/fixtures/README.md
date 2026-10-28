# Archive fixtures (SYNTHETIC)

These files were written by hand to resemble a FoolFuuka-style 4chan archive. They were **not** captured from archiveofsins.com. Class names, element structure, media paths and API field names come from memory of the FoolFuuka software and are **unverified**.

- Hosts are placeholders (`archive.example`, `img.archive.example`). They are intentionally not real.
- Content is neutral lorem ipsum. No scripts, no real posts, no media.
- **Before writing an adapter or tests that depend on these, replace them with real saved pages** (Save as "Webpage, HTML only", trimmed and sanitised) and fix the selectors to match.

| File | Scenario |
|---|---|
| archive-thread.html | Image, GIF, WebM, text-only post, and a post whose file was removed |
| archive-board.html | Board index with 3 threads |
| archive-search.html | 5 search results (jpg, gif, jpg, webm, jpg) |
| archive-removed.html | Every file removed, to exercise the "ignored" report |
| archive-changed-layout.html | Thread data with classes/ids stripped, for the fallback path |
| archive-thread.json | FoolFuuka-style API response (use only if the real site offers an API) |
