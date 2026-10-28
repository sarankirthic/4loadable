import { classifyExt, type ParsedMediaUrl } from '../shared/media-detection';
import type { PageInfo } from '../shared/types';
import type { SiteAdapter } from '../shared/site-adapter';

export const HOST = 'archiveofsins.com';

export const allowedMediaHosts = (hostname: string) => hostname.toLowerCase() === HOST;

// /data/<board>/(image|thumb)/<ts4>/<ts2>/<tim>[s].<ext> — ts4/ts2 are the media filename's own
// leading digits, re-checked below so a crafted path can't point outside its own timestamp bucket.
const MEDIA_RE = /^\/data\/([a-z0-9]{1,10})\/(image|thumb)\/(\d{4})\/(\d{2})\/(\d{4,20})(s)?\.([a-z0-9]{2,5})$/i;

export function parseMediaUrl(raw: string, base = `https://${HOST}/`): ParsedMediaUrl | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return null;
  let u: URL;
  try { u = new URL(raw.trim(), base); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  if (!allowedMediaHosts(u.hostname)) return null;
  const m = MEDIA_RE.exec(u.pathname);
  if (!m) return null;
  const [, board, kind, ts4, ts2, tim, sSuffix, extRaw] = m;
  if (tim.slice(0, 4) !== ts4 || tim.slice(4, 6) !== ts2) return null;
  const isThumb = kind.toLowerCase() === 'thumb';
  if (isThumb !== (sSuffix?.toLowerCase() === 's')) return null; // thumb <-> 's' suffix must agree
  const ext = extRaw.toLowerCase();
  const type = classifyExt(ext);
  if (!type) return null;
  const host = u.hostname.toLowerCase();
  return { url: `https://${host}${u.pathname}`, host, board: board.toLowerCase(), tim, ext, type, isThumb };
}

const THREAD = /^\/([a-z0-9]{1,10})\/thread\/(\d+)\/?$/i;
const BOARD = /^\/([a-z0-9]{1,10})\/(?:\d+\/)?$/i;

export function detectPage(url: URL, title = ''): PageInfo {
  const base = { url: url.href, title, site: 'archiveofsins' };
  if (url.hostname.toLowerCase() !== HOST) return { kind: 'unsupported', ...base };
  let m = THREAD.exec(url.pathname);
  if (m) return { kind: 'thread', board: m[1].toLowerCase(), threadId: m[2], ...base };
  m = BOARD.exec(url.pathname);
  if (m) return { kind: 'board', board: m[1].toLowerCase(), ...base };
  return { kind: 'unsupported', ...base };
}

export const archiveofsinsAdapter: SiteAdapter = {
  id: 'archiveofsins',
  matches: (u) => u.hostname.toLowerCase() === HOST,
  detectPage,
  allowedMediaHosts,
  parseMediaUrl,
  scan() {
    throw new Error('not implemented');
  },
};
