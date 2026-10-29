import type { LibraryEntry, LibrarySource } from './library-types';
import { childrenAt, type FlatLeaf } from './library-tree';
import { toRelativeSegments } from './library-paths';
import { classifyExt, getExtension } from './media-detection';

export interface BrowserRecordsDeps {
  search(q: { state?: 'complete' }): Promise<Array<{ id: number; filename: string; exists?: boolean; totalBytes?: number; startTime?: string }>>;
  show?(id: number): Promise<void>;
  showDefaultFolder?(): Promise<void>;
  removeFile?(id: number): Promise<void>; // chrome.downloads.removeFile
  baseFolder: string;
}

async function loadLeaves(deps: BrowserRecordsDeps): Promise<FlatLeaf[]> {
  const items = await deps.search({ state: 'complete' });
  const leaves: FlatLeaf[] = [];
  for (const item of items) {
    const segments = toRelativeSegments(item.filename, deps.baseFolder);
    if (!segments || segments.length === 0) continue; // outside base folder, or the base dir itself
    const name = segments[segments.length - 1];
    leaves.push({
      path: segments,
      size: item.totalBytes,
      missing: item.exists === false ? true : undefined,
      mediaType: classifyExt(getExtension(name)) ?? undefined,
      downloadId: item.id,
      modifiedAt: item.startTime ? Date.parse(item.startTime) : undefined,
    });
  }
  return leaves;
}

/** LibrarySource backed by chrome.downloads.search — history of files we downloaded, not a live folder scan. */
export function createBrowserRecordsSource(deps: BrowserRecordsDeps): LibrarySource {
  return {
    id: 'browser-records',
    canOrganize: false,

    async *list(path: string[], signal: AbortSignal): AsyncIterable<LibraryEntry> {
      const leaves = await loadLeaves(deps);
      if (signal.aborted) return;
      for (const entry of childrenAt(leaves, path)) yield entry;
    },

    async stat(entry: LibraryEntry) {
      const size = entry.kind === 'folder' ? entry.totalSize : entry.size;
      if (size === undefined || entry.modifiedAt === undefined) return null;
      return { size, modifiedAt: entry.modifiedAt };
    },

    async thumbnail() {
      return null;
    },

    async open() {
      return null;
    },

    async revealInOS(entry: LibraryEntry) {
      if (entry.downloadId !== undefined) await deps.show?.(entry.downloadId);
    },
  };
}
