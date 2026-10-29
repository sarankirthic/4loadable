import { classifyExt, mediaId, parseFileSize, type ParsedMediaUrl } from '../shared/media-detection';
import { splitName } from '../shared/filename-utils';
import type { MediaItem, PageInfo, ThreadSummary } from '../shared/types';
import type { SiteAdapter } from '../shared/site-adapter';
import type { ScanContext, ScanOptions, ScanResult } from '../content/media-scanner';

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

const THREAD = /^\/([a-z0-9]{1,10})\/thread\/(\d+)(?:\/[^/]*)?\/?$/i;
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

const POSTS = 'article.thread, article.post';

/** FoolFuuka nests replies (aside.posts > article.post) inside the OP's article.thread, so a plain
 *  post.querySelector() can pick up a reply's file for an OP without one. Only match elements owned by `post`. */
function own(post: Element, selector: string): Element | null {
  for (const el of Array.from(post.querySelectorAll(selector))) {
    if (el.closest(POSTS) === post) return el;
  }
  return null;
}
const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

/** List OP threads on a board-index page (for the "scan selected threads" flow). */
export function scanThreadList(root: ParentNode): ThreadSummary[] {
  const out: ThreadSummary[] = [];
  for (const el of Array.from(root.querySelectorAll('article.thread[id]'))) {
    const teaser = (own(el, '.post_message, blockquote')?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 140);
    const thumbUrl = own(el, '.thread_image_box img.post_image')?.getAttribute('src') ?? undefined;
    out.push({ id: el.id, teaser: teaser || `Thread ${el.id}`, thumbUrl });
  }
  return out;
}

/** Generic fallback when the expected archive markup is gone: any link that still parses as media. */
function scanFallback(root: ParentNode, ctx: ScanContext, known: Set<string>, order: number): MediaItem[] {
  const out: MediaItem[] = [];
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    const parsed = parseMediaUrl(href, ctx.baseUrl);
    if (!parsed || parsed.isThumb) continue;
    const id = mediaId('archiveofsins', parsed.board, parsed.tim);
    if (known.has(id)) continue;
    known.add(id);
    const name = (a.textContent ?? '').trim();
    out.push({
      id, url: parsed.url, site: 'archiveofsins', board: parsed.board, threadId: ctx.defaultThreadId, postNo: ctx.defaultThreadId,
      tim: parsed.tim, ext: parsed.ext, type: parsed.type, originalName: name ? splitName(name).base : parsed.tim, order: order++,
    });
  }
  return out;
}

export async function scan(root: ParentNode, ctx: ScanContext, opts: ScanOptions = {}): Promise<ScanResult> {
  const known = opts.known ?? new Set<string>();
  const doc = (root as Node).ownerDocument ?? (root as Document);
  const hasContainers = !!doc.querySelector(POSTS);
  if (!hasContainers) {
    const items = scanFallback(root, ctx, known, opts.startOrder ?? 0);
    if (items.length) opts.onItems?.(items);
    return { items, cancelled: false, warning: items.length ? 'The page layout looks different from what this extension expects. Media was found using generic link detection, so details like filenames may be incomplete.' : undefined };
  }
  const posts = Array.from(root.querySelectorAll(POSTS));
  if (root instanceof Element && root.matches(POSTS)) posts.unshift(root);
  const chunk = opts.chunkSize ?? 250;
  const yielder = opts.yieldFn ?? yieldToBrowser;
  const all: MediaItem[] = [];
  let order = opts.startOrder ?? 0;

  for (let i = 0; i < posts.length; i += chunk) {
    if (opts.shouldCancel?.()) return { items: all, cancelled: true };
    const batch: MediaItem[] = [];
    for (const post of posts.slice(i, i + chunk)) {
      const link = own(post, '.thread_image_box a.thread_image_link[href]');
      const fileAnchor = own(post, '.post_file a.post_file_filename');
      if (!link) {
        if (post.classList.contains('has_image') && !fileAnchor) {
          opts.onIgnored?.(`archiveofsins:removed:${post.id}`, 'removed', 'file removed from archive');
        }
        continue;
      }
      const href = link.getAttribute('href') ?? '';
      const parsed = parseMediaUrl(href, ctx.baseUrl);
      if (!parsed || parsed.isThumb) continue;
      const id = mediaId('archiveofsins', parsed.board, parsed.tim);
      opts.elements?.set(id, post);
      if (known.has(id)) continue;
      known.add(id);

      const title = fileAnchor?.getAttribute('title');
      const text = (fileAnchor?.textContent ?? '').trim();
      const rawName = title || (/\(\.\.\.\)/.test(text) ? '' : text);
      const metaText = own(post, '.post_file_metadata')?.textContent ?? '';
      const [sizePart, dimPart] = metaText.split(',');
      const dim = /(\d{1,5})\s*[x×]\s*(\d{1,5})/.exec(dimPart ?? metaText);
      const name = rawName ? splitName(rawName).base : parsed.tim;
      const postNo = post.id || ctx.defaultThreadId;
      const threadId = ctx.defaultThreadId || post.closest('article.thread')?.id || postNo;
      const thumbUrl = own(post, '.thread_image_box img.post_image')?.getAttribute('src') ?? undefined;

      batch.push({
        id, url: parsed.url, thumbUrl, site: 'archiveofsins', board: parsed.board, threadId, postNo, tim: parsed.tim,
        ext: parsed.ext, type: parsed.type, originalName: name || parsed.tim,
        size: parseFileSize(sizePart ?? ''), width: dim ? Number(dim[1]) : undefined, height: dim ? Number(dim[2]) : undefined,
        order: order++,
      });
    }
    all.push(...batch);
    if (batch.length) opts.onItems?.(batch);
    opts.onProgress?.(Math.min(i + chunk, posts.length), posts.length);
    if (i + chunk < posts.length) await yielder();
  }
  return { items: all, cancelled: false };
}

export const archiveofsinsAdapter: SiteAdapter = {
  id: 'archiveofsins',
  matches: (u) => u.hostname.toLowerCase() === HOST,
  detectPage,
  allowedMediaHosts,
  parseMediaUrl,
  scan,
};
