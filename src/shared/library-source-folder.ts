import type { LibraryEntry, LibrarySource } from './library-types';
import { isSafeName } from './library-paths';
import { classifyExt, getExtension } from './media-detection';

export interface DirHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  entries(): AsyncIterable<[string, DirHandleLike | FileHandleLike]>;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
}

export interface FileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<Blob & { name: string; lastModified: number }>;
  createWritable?(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
  move?(dest: DirHandleLike, name?: string): Promise<void>;
}

async function resolveDir(root: DirHandleLike, path: string[]): Promise<DirHandleLike> {
  let dir = root;
  for (const seg of path) dir = await dir.getDirectoryHandle(seg);
  return dir;
}

async function resolveFileHandle(root: DirHandleLike, entry: LibraryEntry): Promise<FileHandleLike> {
  const dir = await resolveDir(root, entry.path.slice(0, -1));
  return dir.getFileHandle(entry.name);
}

/** LibrarySource backed by the File System Access API (or an in-memory fake implementing the same shape). */
export function createFolderSource(root: DirHandleLike, opts?: { writable: boolean }): LibrarySource {
  return {
    id: 'folder',
    canOrganize: opts?.writable === true,

    async *list(path: string[], signal: AbortSignal): AsyncIterable<LibraryEntry> {
      if (signal.aborted) return;
      const dir = await resolveDir(root, path);
      for await (const [name, handle] of dir.entries()) {
        if (signal.aborted) return;
        if (!isSafeName(name)) continue;
        if (handle.kind === 'directory') {
          yield { kind: 'folder', name, path: [...path, name] };
        } else {
          const mediaType = classifyExt(getExtension(name)) ?? undefined;
          yield { kind: 'file', name, path: [...path, name], mediaType };
        }
      }
    },

    async stat(entry: LibraryEntry) {
      if (entry.kind !== 'file') return null;
      const handle = await resolveFileHandle(root, entry);
      const file = await handle.getFile();
      return { size: file.size, modifiedAt: file.lastModified };
    },

    async thumbnail(entry: LibraryEntry) {
      if (entry.kind !== 'file' || entry.mediaType !== 'image' || typeof createImageBitmap !== 'function') return null;
      const handle = await resolveFileHandle(root, entry);
      const file = await handle.getFile();
      try {
        return await createImageBitmap(file, { resizeWidth: 240 });
      } catch {
        return null;
      }
    },

    async open(entry: LibraryEntry) {
      if (entry.kind !== 'file') return null;
      const handle = await resolveFileHandle(root, entry);
      return handle.getFile();
    },
  };
}
