export type MediaType = 'image' | 'gif' | 'video';
export type PageKind = 'thread' | 'board' | 'catalog' | 'unsupported';

export interface MediaItem {
  /** Stable identity: `${site}:${board}:${tim}` (tim is the site's unique upload id). */
  id: string;
  url: string;
  thumbUrl?: string;
  site: string;
  board: string;
  threadId: string;
  postNo: string;
  tim: string;
  ext: string; // lowercase, no dot
  type: MediaType;
  originalName: string; // uploader's filename without extension
  size?: number; // bytes
  width?: number;
  height?: number;
  md5?: string;
  availability?: 'ok' | 'broken';
  order: number;
}

export interface PageInfo {
  kind: PageKind;
  site: string;
  board?: string;
  threadId?: string;
  url: string;
  title: string;
}

export interface ThreadSummary {
  id: string;
  teaser: string;
  thumbUrl?: string;
  replies?: number;
}

/** Media-looking links the scanner deliberately did not turn into items, grouped by cause. */
export interface IgnoredSummary { reason: 'type' | 'host' | 'path' | 'layout'; detail: string; count: number }

export interface Progress { done: number; total: number; label: string }

export interface ScanState {
  tabId: number;
  page: PageInfo;
  items: MediaItem[];
  threads: ThreadSummary[];
  scanning: boolean;
  progress?: Progress;
  errors: string[];
  warning?: string;
  ignored?: IgnoredSummary[];
  updatedAt: number;
}

export type OrganizeMode = 'board-thread-type' | 'board-thread' | 'flat';
export type FilenameMode = 'original' | 'server' | 'template';
export type DuplicateMode = 'rename' | 'skip' | 'prompt';

export interface DownloadOptions {
  rootFolder: string;
  subfolder: string;
  organize: OrganizeMode;
  filenameMode: FilenameMode;
  filenameTemplate: string;
  duplicates: DuplicateMode;
  saveAs: boolean;
  writeManifest: boolean;
}

export interface Settings extends DownloadOptions {
  types: { image: boolean; gif: boolean; video: boolean };
  maxConcurrent: number;
  maxRetries: number;
  view: 'grid' | 'list';
  theme: 'dark' | 'light';
  confirmBulk: boolean;
  confirmThreshold: number;
  rememberSelection: boolean;
  includeQuoted: boolean;
  fullResOnly: boolean;
  inPageToolbar: boolean;
}

export type QueueStatus =
  | 'queued' | 'starting' | 'downloading' | 'paused'
  | 'complete' | 'failed' | 'skipped' | 'cancelled';

export interface QueueItem {
  id: string; // = MediaItem.id, which prevents duplicate queue entries
  url: string;
  path: string; // relative to the browser's download directory
  type: MediaType;
  site: string;
  board: string;
  threadId: string;
  postNo: string;
  originalName: string;
  ext: string;
  md5?: string;
  size?: number;
  conflict: 'uniquify' | 'prompt';
  saveAs: boolean;
  batchId: string;
  manifestDir?: string;
  manifestDone?: boolean;
  status: QueueStatus;
  downloadId?: number;
  attempts: number;
  error?: string;
  errorCode?: string;
  bytes?: number;
  total?: number;
  savedPath?: string;
  notBefore?: number;
  addedAt: number;
  updatedAt: number;
}
export type NewQueueItem = Omit<QueueItem, 'status' | 'attempts' | 'addedAt' | 'updatedAt'>;

export interface HistoryRecord {
  id: string;
  sourceUrl: string;
  originalFilename: string;
  mediaType: MediaType;
  site: string;
  board: string;
  threadId: string;
  postNo: string;
  savedPath: string;
  downloadId?: number;
  status: 'complete' | 'failed' | 'skipped';
  error?: string;
  timestamp: number;
}

export interface DownloadSnapshot {
  id: number;
  state: 'in_progress' | 'interrupted' | 'complete';
  paused: boolean;
  error?: string;
  bytesReceived: number;
  totalBytes: number;
  filename?: string;
  exists?: boolean;
}
