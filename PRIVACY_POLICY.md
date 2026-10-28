# Privacy Policy — 4loadable

_Last updated: October 26, 2026_

4loadable is a browser extension that scans 4chan threads and
boards, lets you select images, GIFs and videos, and saves them through your
browser's own download manager. This policy explains what the extension does
and does not do with your data.

## Data collection

**We do not collect any data.** The extension has no backend server, no
analytics, no telemetry, and no advertising. The developer never receives
any information about you or your use of the extension.

## What stays on your device

The extension stores the following locally in your browser, using the
standard `storage` API. This data never leaves your device and is never
transmitted anywhere:

- Settings (save folder layout, filename template, toolbar preferences)
- The download queue and its progress/retry state
- Download history (used to detect duplicates and support CSV/JSON export)
- Scan results for the thread or board you're viewing

Uninstalling the extension or clearing its storage deletes this data
permanently. Nothing is backed up or synced to any external service.

## Network requests

The only network traffic the extension makes is directly between your
browser and 4chan's own infrastructure:

- **Downloads** — fetching the media files you explicitly select, via
  `i.4cdn.org` (and `is*.4cdn.org` as a defensive fallback)
- **Thread/board scanning** — reading 4chan's public JSON API at
  `a.4cdn.org`, rate-limited to one request per second, and only while you
  are actively scanning
- **Optional "check for deleted files"** — a single HEAD request per file,
  sent only when you click that button

No request is ever sent to any server other than 4chan's own domains. No
third party receives any data from this extension.

## Permissions

| Permission | Purpose |
|---|---|
| `downloads` | Save files you select and detect when each finishes |
| `storage` | Store settings, queue state, history and scan results locally |
| `alarms` | Wake the background worker so the download queue survives it going idle |
| Host access to `boards.4chan.org`, `boards.4channel.org` | Read posts on the 4chan page you're viewing |
| Host access to `a.4cdn.org` | 4chan's public API, used only when you scan a thread or board |
| Host access to `i.4cdn.org` | 4chan's media host, used to download files and for optional availability checks |

The extension does not request `tabs`, `activeTab`, `scripting`, or access
to any site other than 4chan.

## Changes to this policy

If this policy changes, the updated version will be posted at this same
location with a revised "Last updated" date.

## Contact

Questions about this policy can be sent to: sarankirthic@gmail.com
