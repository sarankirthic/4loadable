import type { MediaItem, MediaType } from './types';

export const IMAGE_EXTS = ['jpg', 'jpeg', 'jfif', 'png', 'apng', 'webp', 'avif', 'bmp'];
export const GIF_EXTS = ['gif'];
export const VIDEO_EXTS = ['webm', 'mp4', 'gifv', 'mkv', 'mov', 'm4v'];

/** Hosts media may be downloaded from. Keep this list short on purpose. */
const HOST_EXACT = new Set(['i.4cdn.org']);
const HOST_PATTERNS = [/^is\d*\.4chan\.org$/i];

export function isAllowedMediaHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return HOST_EXACT.has(h) || HOST_PATTERNS.some((r) => r.test(h));
}

export function getExtension(nameOrUrl: string): string {
  let s = String(nameOrUrl ?? '');
  try { s = new URL(s, 'https://x.invalid/').pathname; } catch { /* plain filename */ }
  const base = s.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function classifyExt(ext: string): MediaType | null {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (GIF_EXTS.includes(e)) return 'gif';
  if (VIDEO_EXTS.includes(e)) return 'video';
  if (IMAGE_EXTS.includes(e)) return 'image';
  return null;
}

export interface ParsedMediaUrl {
  url: string; // canonical https URL, no query/hash
  host: string;
  board: string;
  tim: string;
  ext: string;
  type: MediaType;
  isThumb: boolean;
}

const PATH_RE = /^\/([a-z0-9]{1,10})\/(\d{9,20})(s?)\.([a-z0-9]{2,5})$/i;

/** Validate and parse a 4chan media URL. Returns null for anything unexpected. */
export function parseMediaUrl(raw: string, base = 'https://boards.4chan.org/'): ParsedMediaUrl | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return null;
  let u: URL;
  try { u = new URL(raw.trim(), base); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443' && u.port !== '80') return null;
  if (!isAllowedMediaHost(u.hostname)) return null;
  const m = PATH_RE.exec(u.pathname);
  if (!m) return null;
  const [, board, tim, s, extRaw] = m;
  const ext = extRaw.toLowerCase();
  const type = classifyExt(ext);
  if (!type) return null;
  const isThumb = s.toLowerCase() === 's' && ext === 'jpg';
  // An 's' suffix with any other extension is not a pattern 4chan uses for thumbnails.
  if (s && !isThumb) return null;
  const host = u.hostname.toLowerCase();
  return { url: `https://${host}${u.pathname}`, host, board: board.toLowerCase(), tim, ext, type, isThumb };
}

export function isThumbnailUrl(url: string): boolean {
  return parseMediaUrl(url)?.isThumb === true;
}

export function thumbUrlFor(board: string, tim: string): string {
  return `https://i.4cdn.org/${board}/${tim}s.jpg`;
}

/** Thumbnails are always .jpg, so the real extension must be supplied (from the post's file link). */
export function thumbnailToOriginal(thumbUrl: string, ext: string): string | null {
  const p = parseMediaUrl(thumbUrl);
  if (!p || !p.isThumb) return null;
  const e = ext.toLowerCase().replace(/^\./, '');
  if (!classifyExt(e)) return null;
  return `https://${p.host}/${p.board}/${p.tim}.${e}`;
}

/** When the extension is unknown (catalog thumbnails), list plausible originals in 4chan's upload formats. */
export function thumbnailOriginalCandidates(thumbUrl: string): string[] {
  return ['jpg', 'png', 'gif', 'webm', 'mp4', 'webp']
    .map((e) => thumbnailToOriginal(thumbUrl, e))
    .filter((x): x is string => !!x);
}

export const mediaId = (site: string, board: string, tim: string) => `${site.toLowerCase()}:${board.toLowerCase()}:${tim}`;

/** "1.2 MB" -> bytes (binary units; archive sites use KiB/MiB/GiB, 4chan uses KB/MB/GB — treated the same). */
export function parseFileSize(text: string): number | undefined {
  const m = /([\d.,]+)\s*(B|KB|KiB|MB|MiB|GB|GiB)\b/i.exec(text ?? '');
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toUpperCase().replace('I', '') as 'B' | 'KB' | 'MB' | 'GB';
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit];
  return Math.round(n * mult);
}

export interface ApiPost {
  no: number; resto?: number; tim?: number; ext?: string; filename?: string;
  fsize?: number; w?: number; h?: number; md5?: string; filedeleted?: number;
}

/** Build a MediaItem from an entry in a.4cdn.org thread JSON. */
export function itemFromApiPost(board: string, threadId: string, p: ApiPost, order = 0): MediaItem | null {
  if (!p || p.tim == null || !p.ext || p.filedeleted) return null;
  const parsed = parseMediaUrl(`https://i.4cdn.org/${board}/${p.tim}${p.ext}`);
  if (!parsed || parsed.isThumb) return null;
  return {
    id: mediaId('fourchan', parsed.board, parsed.tim), url: parsed.url, thumbUrl: thumbUrlFor(parsed.board, parsed.tim),
    site: 'fourchan', board: parsed.board, threadId, postNo: String(p.no), tim: parsed.tim, ext: parsed.ext, type: parsed.type,
    originalName: p.filename ?? parsed.tim, size: p.fsize, width: p.w, height: p.h, md5: p.md5, order,
  };
}

/** Merge new items into an existing list, dropping duplicates by id. Order is reassigned monotonically. */
export function mergeMedia(existing: MediaItem[], incoming: MediaItem[]): { items: MediaItem[]; added: number } {
  const seen = new Set(existing.map((i) => i.id));
  const items = existing.slice();
  let added = 0;
  for (const it of incoming) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    items.push({ ...it, order: items.length });
    added++;
  }
  return { items, added };
}
