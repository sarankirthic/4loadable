import type { DownloadOptions, MediaItem, MediaType } from './types';

// Control chars, path separators, Windows-reserved chars, and bidi overrides (used to spoof extensions).
// eslint-disable-next-line no-control-regex
const BAD = /[<>:"/\\|?*\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_PATH = 230;

export function sanitizeSegment(input: unknown, fallback = 'file', max = 100): string {
  let s = String(input ?? '').normalize('NFC').replace(BAD, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/\.{2,}/g, '.').replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!s) return fallback;
  if (RESERVED.test(s.split('.')[0])) s = '_' + s;
  return s.length > max ? s.slice(0, max).replace(/[. ]+$/, '') || fallback : s;
}

/** Sanitize a user-supplied folder path. Drops '', '.', '..'; never returns absolute paths. */
export function sanitizeFolderPath(input: unknown): string[] {
  return String(input ?? '')
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .map((p) => sanitizeSegment(p, '_'))
    .filter(Boolean);
}

export function splitName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i + 1) };
}

export function sanitizeFilename(base: string, ext: string, maxBase = 120): string {
  const e = ext.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const b = sanitizeSegment(base, 'file', maxBase);
  return e ? `${b}.${e}` : b;
}

export const typeFolder = (t: MediaType) => (t === 'image' ? 'images' : t === 'gif' ? 'gifs' : 'videos');

export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : ''));
}

export interface PathContext { index: number; date: string }

/** `threadDir` is the folder that should hold manifest.json (the thread level, above images/gifs/videos). */
export function buildTargetPath(item: MediaItem, o: DownloadOptions, ctx: PathContext): { dir: string; threadDir: string; path: string } {
  const dirParts = [...sanitizeFolderPath(o.rootFolder), ...sanitizeFolderPath(o.subfolder)];
  if (o.organize !== 'flat') dirParts.push(sanitizeSegment(item.board, '_'), sanitizeSegment(item.threadId, '_'));
  const threadDir = dirParts.join('/');
  if (o.organize === 'board-thread-type') dirParts.push(typeFolder(item.type));
  const dir = dirParts.join('/');

  const orig = item.originalName || item.tim;
  let base: string;
  if (o.filenameMode === 'server') base = item.tim;
  else if (o.filenameMode === 'template') {
    base = renderTemplate(o.filenameTemplate || '{original}', {
      original: sanitizeSegment(orig, item.tim), server: item.tim, post: item.postNo, thread: item.threadId,
      board: item.board, index: String(ctx.index).padStart(4, '0'), type: item.type, date: ctx.date,
    });
  } else base = orig;

  // Leave room for the directory so the total path stays below common OS limits.
  const room = Math.max(20, Math.min(120, MAX_PATH - dir.length - item.ext.length - 2));
  const name = sanitizeFilename(base, item.ext, room);
  return { dir, threadDir, path: dir ? `${dir}/${name}` : name };
}

/** Make a list of paths unique (case-insensitive) by appending -2, -3, ... before the extension. */
export function ensureUniquePaths(paths: string[], taken: Set<string> = new Set()): string[] {
  const used = new Set(Array.from(taken, (p) => p.toLowerCase()));
  return paths.map((p) => {
    let candidate = p;
    if (used.has(candidate.toLowerCase())) {
      const slash = candidate.lastIndexOf('/');
      const dir = slash >= 0 ? candidate.slice(0, slash + 1) : '';
      const { base, ext } = splitName(candidate.slice(slash + 1));
      for (let n = 2; ; n++) {
        candidate = `${dir}${base}-${n}${ext ? '.' + ext : ''}`;
        if (!used.has(candidate.toLowerCase())) break;
      }
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Final defense before handing a path to the downloads API. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 250) return false;
  if (/^([a-z]:|[\\/])/i.test(p)) return false;
  return p.split('/').every((s) => s && s !== '.' && s !== '..' && !BAD.test(s) && !(BAD.lastIndex = 0));
}
