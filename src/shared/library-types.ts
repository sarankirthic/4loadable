import type { MediaType } from './types';

export type LibrarySourceId = 'browser-records' | 'folder';

export interface LibraryEntry {
  kind: 'folder' | 'file';
  name: string; // already sanitized
  path: string[];
  mediaType?: MediaType;
  size?: number;
  modifiedAt?: number;
  downloadId?: number;
  missing?: boolean;
  fileCount?: number; // folders: undefined until scanned
  totalSize?: number; // folders: undefined until scanned
  handle?: unknown; // opaque, source-specific
}

export interface LibrarySource {
  readonly id: LibrarySourceId;
  readonly canOrganize: boolean;
  list(path: string[], signal: AbortSignal): AsyncIterable<LibraryEntry>; // yields name+kind first
  stat(entry: LibraryEntry): Promise<{ size: number; modifiedAt: number } | null>; // lazy size/date
  thumbnail(entry: LibraryEntry): Promise<ImageBitmap | null>;
  open(entry: LibraryEntry): Promise<Blob | null>;
  revealInOS?(entry: LibraryEntry): Promise<void>;
}
