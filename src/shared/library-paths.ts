import { sanitizeSegment } from './filename-utils';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A single path segment is "safe" if it can be used as-is: not empty/'.'/'..' , no separators, no control chars, not too long. */
export function isSafeName(name: string): boolean {
  if (typeof name !== 'string' || !name) return false;
  if (name === '.' || name === '..') return false;
  if (name.length > 200) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (CONTROL.test(name)) return false;
  return true;
}

/** Sanitize a single entry (file/folder) name using the same rules as the filename sanitizer. */
export function sanitizeEntryName(name: string): string {
  return sanitizeSegment(name, 'file', 200);
}

/**
 * Convert an absolute path into segments relative to `baseFolder`.
 * Returns null if `absPath` is not under `baseFolder`, or if any resulting
 * segment is unsafe (never silently dropped — the whole path is rejected).
 */
export function toRelativeSegments(absPath: string, baseFolder: string): string[] | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = norm(String(absPath ?? ''));
  const base = norm(String(baseFolder ?? ''));
  if (!base) return null;
  const absLower = abs.toLowerCase();
  const baseLower = base.toLowerCase();
  if (absLower !== baseLower && !absLower.startsWith(baseLower + '/')) return null;
  const rest = abs.slice(base.length).replace(/^\/+/, '');
  if (!rest) return [];
  const segments = rest.split('/');
  return segments.every(isSafeName) ? segments : null;
}
