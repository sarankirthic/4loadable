import type { DownloadOptions, IgnoredSummary, MediaItem, PageInfo, Progress, ThreadSummary } from './types';

export type DownloadScope = 'all' | 'selected' | 'ids';

export type Msg =
  // content -> background
  | { type: 'SCAN_BATCH'; page: PageInfo; items: MediaItem[]; threads?: ThreadSummary[]; scanning: boolean; progress?: Progress; warning?: string; ignored?: IgnoredSummary[]; reset?: boolean }
  // UI / toolbar -> background
  | { type: 'DOWNLOAD_REQUEST'; /** -1 = the sender's own tab */ tabId: number; scope: DownloadScope; ids?: string[]; options?: Partial<DownloadOptions>; types?: { image: boolean; gif: boolean; video: boolean }; confirmed?: boolean }
  | { type: 'QUEUE_ACTION'; action: 'pause' | 'resume' | 'cancel' | 'retry' | 'pauseAll' | 'resumeAll' | 'cancelAll' | 'retryFailed' | 'clearFinished'; id?: string }
  | { type: 'SCAN_THREADS'; tabId: number; board: string; threadIds: string[] }
  | { type: 'LIST_BOARD_THREADS'; tabId: number; board: string }
  | { type: 'CANCEL_THREAD_SCAN'; tabId: number }
  | { type: 'CHECK_LINKS'; tabId: number; ids: string[] }
  | { type: 'SELECT'; mode: 'replace' | 'add'; ids: string[]; tabId?: number }
  | { type: 'OPEN_MANAGER'; tabId?: number }
  | { type: 'REQUEST_SITE_PERMISSION'; site: 'archiveofsins' }
  | { type: 'SITE_PERMISSION_STATUS'; site: 'archiveofsins' };

// background -> content
export type TabMsg = { type: 'SCAN_PAGE' } | { type: 'CANCEL_SCAN' } | { type: 'GET_VISIBLE_IDS' } | { type: 'SETTINGS_CHANGED' };

export interface DownloadResponse {
  ok: boolean; error?: string; needsConfirm?: boolean; count?: number;
  added?: number; duplicates?: number; skipped?: { id: string; reason: string }[];
}

const api = () => (globalThis as any).chrome;

export async function send<T = any>(msg: Msg): Promise<T | undefined> {
  try { return await api().runtime.sendMessage(msg); } catch { return undefined; }
}
export async function sendToTab<T = any>(tabId: number, msg: TabMsg): Promise<T | undefined> {
  try { return await api().tabs.sendMessage(tabId, msg); } catch { return undefined; }
}

export const scanKey = (tabId: number) => `scan:${tabId}`;
export const selectionKey = (tabId: number) => `selection:${tabId}`;
