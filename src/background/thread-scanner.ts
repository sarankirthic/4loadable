import { itemFromApiPost, type ApiPost } from '../shared/media-detection';
import type { MediaItem, ThreadSummary } from '../shared/types';

export const API_BASE = 'https://a.4cdn.org';
/** 4chan API rules: no more than one request per second. */
export const API_INTERVAL_MS = 1100;

const BOARD_RE = /^[a-z0-9]{1,10}$/i;
const ID_RE = /^\d{1,12}$/;
export const validBoard = (b: string) => BOARD_RE.test(b);
export const validThreadId = (t: string) => ID_RE.test(t);

export interface ThreadFetchDeps {
  fetchJson(url: string, signal: AbortSignal): Promise<{ status: number; json?: any }>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export function itemsFromThreadJson(board: string, threadId: string, json: { posts?: ApiPost[] }): MediaItem[] {
  const out: MediaItem[] = [];
  for (const p of json.posts ?? []) { const it = itemFromApiPost(board, threadId, p, out.length); if (it) out.push(it); }
  return out;
}

export interface ThreadScanCallbacks {
  onItems(items: MediaItem[], done: number, total: number, label: string): Promise<void> | void;
  onError(msg: string): void;
}

/** Fetch threads one at a time, honoring the API rate limit and cancellation. Never crawls beyond the IDs given. */
export async function scanThreads(board: string, threadIds: string[], deps: ThreadFetchDeps, cb: ThreadScanCallbacks, signal: AbortSignal) {
  if (!validBoard(board)) { cb.onError('Invalid board name.'); return; }
  const ids = [...new Set(threadIds.filter(validThreadId))];
  let done = 0;
  for (const id of ids) {
    if (signal.aborted) return;
    try {
      const r = await deps.fetchJson(`${API_BASE}/${board}/thread/${id}.json`, signal);
      if (r.status === 404) cb.onError(`Thread ${id} is gone (404).`);
      else if (r.status !== 200 || !r.json) cb.onError(`Thread ${id}: server returned ${r.status}.`);
      else await cb.onItems(itemsFromThreadJson(board, id, r.json), ++done, ids.length, `Thread ${id}`);
      if (r.status !== 200) done++;
    } catch (e) {
      if (signal.aborted) return;
      cb.onError(`Thread ${id}: network error (${(e as Error).message}).`);
      done++;
    }
    if (done < ids.length) { try { await deps.sleep(API_INTERVAL_MS, signal); } catch { return; } }
  }
  if (!signal.aborted) await cb.onItems([], ids.length, ids.length, 'Done');
}

export async function listBoardThreads(board: string, deps: ThreadFetchDeps, signal: AbortSignal): Promise<ThreadSummary[]> {
  if (!validBoard(board)) throw new Error('Invalid board name.');
  const r = await deps.fetchJson(`${API_BASE}/${board}/threads.json`, signal);
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`Could not list threads (HTTP ${r.status}).`);
  const out: ThreadSummary[] = [];
  for (const page of r.json) for (const t of page.threads ?? []) out.push({ id: String(t.no), teaser: `Thread ${t.no}`, replies: t.replies });
  return out;
}

export const realDeps: ThreadFetchDeps = {
  async fetchJson(url, signal) {
    const res = await fetch(url, { signal, credentials: 'omit', cache: 'no-cache' });
    return { status: res.status, json: res.ok ? await res.json() : undefined };
  },
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  }),
};
