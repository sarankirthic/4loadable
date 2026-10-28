import { scanDocument, scanThreadList } from '../content/media-scanner';
import { detectPage } from '../content/page-detector';
import { isAllowedMediaHost, parseMediaUrl } from '../shared/media-detection';
import type { SiteAdapter } from '../shared/site-adapter';

const HOSTS = new Set(['boards.4chan.org', 'boards.4channel.org']);

export const fourchanAdapter: SiteAdapter = {
  id: 'fourchan',
  matches: (u) => HOSTS.has(u.hostname.toLowerCase()),
  detectPage: (u, title) => detectPage({ hostname: u.hostname, pathname: u.pathname, href: u.href }, title),
  scan: scanDocument,
  allowedMediaHosts: isAllowedMediaHost,
  parseMediaUrl,
};

// Re-exported for the content script's board/catalog thread-listing path, which has no
// adapter-level hook yet (YAGNI until a second adapter needs its own thread listing).
export { scanThreadList };
