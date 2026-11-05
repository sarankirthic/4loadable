import type { MediaType } from './types';
import type { LibraryEntry } from './library-types';

export interface FlatLeaf {
  path: string[];
  size?: number;
  missing?: boolean;
  mediaType?: MediaType;
  downloadId?: number;
  modifiedAt?: number;
}

/** Group flat leaves into the immediate folder/file entries that sit directly under `path`. */
export function childrenAt(leaves: FlatLeaf[], path: string[]): LibraryEntry[] {
  const depth = path.length;
  const under = leaves.filter((l) => l.path.length > depth && path.every((seg, i) => l.path[i] === seg));

  const files: LibraryEntry[] = [];
  const folders = new Map<string, { fileCount: number; totalSize: number; missingCount: number; modifiedAt?: number }>();

  for (const leaf of under) {
    const name = leaf.path[depth];
    if (leaf.path.length === depth + 1) {
      files.push({
        kind: 'file',
        name,
        path: leaf.path.slice(),
        mediaType: leaf.mediaType,
        size: leaf.size,
        modifiedAt: leaf.modifiedAt,
        downloadId: leaf.downloadId,
        missing: leaf.missing,
      });
      continue;
    }
    let agg = folders.get(name);
    if (!agg) { agg = { fileCount: 0, totalSize: 0, missingCount: 0 }; folders.set(name, agg); }
    agg.fileCount += 1;
    if (typeof leaf.size === 'number') agg.totalSize += leaf.size;
    if (leaf.missing) agg.missingCount += 1;
    if (leaf.modifiedAt !== undefined && (agg.modifiedAt === undefined || leaf.modifiedAt > agg.modifiedAt)) agg.modifiedAt = leaf.modifiedAt;
  }

  const folderEntries: LibraryEntry[] = Array.from(folders.entries()).map(([name, agg]) => ({
    kind: 'folder' as const,
    name,
    path: [...path, name],
    fileCount: agg.fileCount,
    totalSize: agg.totalSize,
    modifiedAt: agg.modifiedAt,
    // A folder is "missing" only when every file under it is gone.
    missing: agg.fileCount > 0 && agg.missingCount === agg.fileCount ? true : undefined,
  }));

  return [...folderEntries, ...files];
}

export type SortKey = 'name' | 'date' | 'size';

/** Sort entries: folders always before files; within each group, unknown size/date sort last regardless of direction. */
export function sortEntries(entries: LibraryEntry[], key: SortKey, dir: 'asc' | 'desc'): LibraryEntry[] {
  const mul = dir === 'asc' ? 1 : -1;
  const sizeOf = (e: LibraryEntry) => (e.kind === 'folder' ? e.totalSize : e.size);

  const cmp = (a: LibraryEntry, b: LibraryEntry): number => {
    if (key === 'name') return mul * a.name.localeCompare(b.name);
    const av = key === 'date' ? a.modifiedAt : sizeOf(a);
    const bv = key === 'date' ? b.modifiedAt : sizeOf(b);
    if (av === undefined && bv === undefined) return a.name.localeCompare(b.name);
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    return mul * (av - bv);
  };

  const folders = entries.filter((e) => e.kind === 'folder').sort(cmp);
  const files = entries.filter((e) => e.kind === 'file').sort(cmp);
  return [...folders, ...files];
}

/** Case-insensitive name filter, plus optional media-type filter (folders and untyped files always pass the type check). */
export function filterEntries(entries: LibraryEntry[], o: { query?: string; types?: MediaType[] }): LibraryEntry[] {
  const q = o.query?.trim().toLowerCase();
  return entries.filter((e) => {
    if (q && !e.name.toLowerCase().includes(q)) return false;
    if (o.types && o.types.length > 0 && e.kind === 'file' && e.mediaType && !o.types.includes(e.mediaType)) return false;
    return true;
  });
}
