import type { PageInfo } from '../shared/types';

const HOSTS = new Set(['boards.4chan.org', 'boards.4channel.org']);
const THREAD = /^\/([a-z0-9]{1,10})\/thread\/(\d+)(?:\/[^/]*)?\/?$/i;
const CATALOG = /^\/([a-z0-9]{1,10})\/catalog\/?$/i;
const BOARD = /^\/([a-z0-9]{1,10})(?:\/(\d{1,3}))?\/?$/i;

/** Classify a 4chan URL. Pure function so it can be unit-tested and updated when the site changes. */
export function detectPage(loc: { hostname: string; pathname: string; href: string }, title = ''): PageInfo {
  const base = { url: loc.href, title, site: 'fourchan' };
  if (!HOSTS.has(loc.hostname.toLowerCase())) return { kind: 'unsupported', ...base };
  let m = THREAD.exec(loc.pathname);
  if (m) return { kind: 'thread', board: m[1].toLowerCase(), threadId: m[2], ...base };
  m = CATALOG.exec(loc.pathname);
  if (m) return { kind: 'catalog', board: m[1].toLowerCase(), ...base };
  m = BOARD.exec(loc.pathname);
  if (m) return { kind: 'board', board: m[1].toLowerCase(), ...base };
  return { kind: 'unsupported', ...base };
}

export function pageLabel(p: PageInfo): string {
  if (p.kind === 'thread') return `/${p.board}/ · thread ${p.threadId}`;
  if (p.kind === 'board') return `/${p.board}/ · board page`;
  if (p.kind === 'catalog') return `/${p.board}/ · catalog`;
  return 'Not a 4chan board or thread';
}
