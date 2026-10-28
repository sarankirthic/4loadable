import { classifyExt, isAllowedMediaHost, mediaId, parseFileSize, parseMediaUrl, thumbUrlFor } from '../shared/media-detection';
import { splitName } from '../shared/filename-utils';
import type { IgnoredSummary, MediaItem, ThreadSummary } from '../shared/types';

export interface ScanContext { board: string; defaultThreadId: string; includeQuoted: boolean; baseUrl: string }
export interface ScanOptions {
  known?: Set<string>;                       // ids already reported; also receives new ids
  elements?: Map<string, Element>;           // id -> anchor element (for "select visible")
  chunkSize?: number;
  shouldCancel?: () => boolean;
  onProgress?: (done: number, total: number) => void;
  onItems?: (batch: MediaItem[]) => void;    // called per chunk so large pages stream in
  yieldFn?: () => Promise<void>;
  startOrder?: number;
  /** Called for media-looking links that were not turned into items (deduped by the caller via href). */
  onIgnored?: (href: string, reason: IgnoredSummary['reason'], detail: string) => void;
}
export interface ScanResult { items: MediaItem[]; warning?: string; cancelled: boolean }

// Only a few stable class names are relied on, and each has a structural fallback.
const FILE_CONTAINER = '.file, .fileThumb, .fileText, .file-info';
const EXCLUDED = '#qp, #ihover, .inline, .inlined';
const ANCHORS = 'a[href*="4cdn.org"], a[href*="4chan.org"]';
const FILEISH = /^\/[a-z0-9]{1,10}\/\d{9,20}s?\.[a-z0-9]{2,5}$/i;
const CHAN_HOST = /(^|\.)4(cdn|chan|channel)\.org$/i;

/** Work out why a file-like 4chan link was not accepted, so the UI can say so instead of silently missing it. */
export function explainIgnored(href: string, base: string): { reason: IgnoredSummary['reason']; detail: string } | null {
  let u: URL;
  try { u = new URL(href, base); } catch { return null; }
  if (!CHAN_HOST.test(u.hostname) || !FILEISH.test(u.pathname)) return null; // not a media file link at all
  if (!isAllowedMediaHost(u.hostname)) return { reason: 'host', detail: u.hostname };
  const ext = u.pathname.split('.').pop()!.toLowerCase();
  if (!classifyExt(ext)) return { reason: 'type', detail: '.' + ext };
  return { reason: 'path', detail: u.pathname };
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

function collectAnchors(root: ParentNode): Element[] {
  const list = Array.from(root.querySelectorAll(ANCHORS));
  if (root instanceof Element && root.matches(ANCHORS)) list.unshift(root);
  return list;
}

const digits = (id: string | null | undefined, re: RegExp) => re.exec(id ?? '')?.[1];

function findPost(a: Element): Element | null {
  return a.closest('.post') ?? a.closest('.postContainer') ?? a.closest('[id^="p"]');
}

function readMeta(post: Element | null, a: Element) {
  const info = (post ?? a.parentElement)?.querySelector('.fileText, .file-info') ?? null;
  const text = info?.textContent ?? '';
  const dim = /(\d{1,5})\s*[x×]\s*(\d{1,5})/.exec(text);
  const sizeMatch = /\(([\d.,]+\s*[KMG]?B)/i.exec(text);
  const nameEl = info?.querySelector('a[title]') ?? info?.querySelector('a[href]') ?? null;
  const rawName = (nameEl?.getAttribute('title') || nameEl?.textContent || '').trim();
  return {
    rawName: /\(\.\.\.\)/.test(rawName) ? '' : rawName, // truncated names are not trustworthy
    size: sizeMatch ? parseFileSize(sizeMatch[1]) : undefined,
    width: dim ? Number(dim[1]) : undefined,
    height: dim ? Number(dim[2]) : undefined,
  };
}

export async function scanDocument(root: ParentNode, ctx: ScanContext, opts: ScanOptions = {}): Promise<ScanResult> {
  const doc = (root as Node).ownerDocument ?? (root as Document);
  const known = opts.known ?? new Set<string>();
  const anchors = collectAnchors(root);
  const hasContainers = !!doc.querySelector(FILE_CONTAINER);
  const chunk = opts.chunkSize ?? 250;
  const yielder = opts.yieldFn ?? yieldToBrowser;
  const all: MediaItem[] = [];
  let order = opts.startOrder ?? 0;
  let usedFallback = false;

  for (let i = 0; i < anchors.length; i += chunk) {
    if (opts.shouldCancel?.()) return { items: all, cancelled: true };
    const batch: MediaItem[] = [];
    for (const a of anchors.slice(i, i + chunk)) {
      const href = a.getAttribute('href') ?? '';
      const p = parseMediaUrl(href, ctx.baseUrl);
      if (!p) {
        const why = opts.onIgnored && explainIgnored(href, ctx.baseUrl);
        if (why) opts.onIgnored!(href, why.reason, why.detail);
        continue;
      }
      if (p.isThumb) continue;
      if (hasContainers && !a.closest(FILE_CONTAINER)) {
        // Plain links typed into post text are intentionally ignored; thumbnail links outside the usual markup are not.
        if (a.querySelector('img')) opts.onIgnored?.(href, 'layout', 'file link outside the usual post markup');
        continue;
      }
      if (!hasContainers) usedFallback = true;
      if (!ctx.includeQuoted && a.closest(EXCLUDED)) continue;
      const id = mediaId('fourchan', p.board, p.tim);
      opts.elements?.set(id, a);
      if (known.has(id)) continue;
      known.add(id);
      const post = findPost(a);
      const postNo = digits(post?.id, /^(?:pc|p)(\d+)$/) ?? digits(a.closest('.postContainer')?.id, /^pc(\d+)$/) ?? ctx.defaultThreadId ?? '';
      const threadId = digits(a.closest('.thread')?.id, /^t(\d+)$/) ?? ctx.defaultThreadId;
      const meta = readMeta(post, a);
      const name = meta.rawName ? splitName(meta.rawName).base : p.tim;
      batch.push({
        id, url: p.url, thumbUrl: thumbUrlFor(p.board, p.tim), site: 'fourchan', board: p.board, threadId, postNo, tim: p.tim,
        ext: p.ext, type: p.type, originalName: name || p.tim, size: meta.size, width: meta.width, height: meta.height,
        order: order++,
      });
    }
    all.push(...batch);
    if (batch.length) opts.onItems?.(batch);
    opts.onProgress?.(Math.min(i + chunk, anchors.length), anchors.length);
    if (i + chunk < anchors.length) await yielder();
  }
  const warning = usedFallback && all.length
    ? 'The page layout looks different from what this extension expects. Media was found using generic link detection, so details like filenames may be incomplete.'
    : undefined;
  return { items: all, warning, cancelled: false };
}

/** List threads visible on a board page or catalog (for the "scan selected threads" flow). */
export function scanThreadList(root: ParentNode): ThreadSummary[] {
  const out = new Map<string, ThreadSummary>();
  for (const el of Array.from(root.querySelectorAll('.thread[id]'))) {
    const id = digits(el.id, /^(?:t|thread-)(\d+)$/);
    if (!id || out.has(id)) continue;
    const teaser = (el.querySelector('.teaser, .subject, .postMessage')?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 140);
    const img = el.querySelector('img.thumb, .fileThumb img, img');
    const thumb = img ? parseMediaUrl(img.getAttribute('src') ?? '') : null;
    const replies = Number(el.querySelector('.meta b')?.textContent?.trim());
    out.set(id, { id, teaser: teaser || `Thread ${id}`, thumbUrl: thumb?.url, replies: Number.isFinite(replies) ? replies : undefined });
  }
  return [...out.values()];
}
