import type { DirHandleLike, FileHandleLike } from './library-source-folder';
import { isSafeName } from './library-paths';

export interface FsLike {
  exists(path: string[]): Promise<'file' | 'folder' | null>;
  size(path: string[]): Promise<number>;
  mkdirp(path: string[]): Promise<void>;
  /** Feature-detects handle.move() internally; falls back to copy-verify-delete. Throws on
   *  verification failure or error, leaving the source intact and removing any partial dest. */
  move(from: string[], to: string[]): Promise<void>;
  /** Streams; removes the partial destination file on error/abort. */
  copyFile(from: string[], to: string[], signal: AbortSignal): Promise<void>;
  /** File only (non-recursive) — refuses to remove folders. */
  remove(path: string[]): Promise<void>;
  list(path: string[]): Promise<Array<{ name: string; kind: 'file' | 'folder' }>>;
}

function validatePath(path: string[]): void {
  for (const seg of path) {
    if (!isSafeName(seg)) throw new Error(`unsafe path segment: ${JSON.stringify(seg)}`);
  }
}

/** Every path below is resolved relative to `root`; every segment is validated with isSafeName
 *  before any filesystem call is made. */
export function createFsLike(root: DirHandleLike): FsLike {
  async function resolveDir(path: string[]): Promise<DirHandleLike> {
    let dir = root;
    for (const seg of path) dir = await dir.getDirectoryHandle(seg);
    return dir;
  }

  async function resolveDirSafe(path: string[]): Promise<DirHandleLike | null> {
    let dir = root;
    for (const seg of path) {
      try {
        dir = await dir.getDirectoryHandle(seg);
      } catch {
        return null;
      }
    }
    return dir;
  }

  async function isFolder(parent: DirHandleLike, name: string): Promise<boolean> {
    try {
      await parent.getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  const fs: FsLike = {
    async exists(path) {
      validatePath(path);
      if (path.length === 0) return 'folder';
      const parent = await resolveDirSafe(path.slice(0, -1));
      if (!parent) return null;
      const name = path[path.length - 1];
      if (await isFolder(parent, name)) return 'folder';
      try {
        await parent.getFileHandle(name);
        return 'file';
      } catch {
        return null;
      }
    },

    async size(path) {
      validatePath(path);
      if (path.length === 0) throw new Error('size: path must point to a file');
      const parent = await resolveDir(path.slice(0, -1));
      const handle = await parent.getFileHandle(path[path.length - 1]);
      const file = await handle.getFile();
      return file.size;
    },

    async mkdirp(path) {
      validatePath(path);
      let dir = root;
      for (const seg of path) dir = await dir.getDirectoryHandle(seg, { create: true });
    },

    async list(path) {
      validatePath(path);
      const dir = await resolveDir(path);
      const out: Array<{ name: string; kind: 'file' | 'folder' }> = [];
      for await (const [name, handle] of dir.entries()) {
        if (!isSafeName(name)) continue;
        out.push({ name, kind: handle.kind === 'directory' ? 'folder' : 'file' });
      }
      return out;
    },

    async remove(path) {
      validatePath(path);
      if (path.length === 0) throw new Error('remove: cannot remove root');
      const parent = await resolveDir(path.slice(0, -1));
      const name = path[path.length - 1];
      if (await isFolder(parent, name)) {
        throw new Error(`remove() refuses folders: ${path.join('/')}`);
      }
      await parent.removeEntry(name);
    },

    async copyFile(from, to, signal) {
      validatePath(from);
      validatePath(to);
      const fromDir = await resolveDir(from.slice(0, -1));
      const fromHandle = await fromDir.getFileHandle(from[from.length - 1]);

      const toDirPath = to.slice(0, -1);
      if (toDirPath.length > 0) await fs.mkdirp(toDirPath);
      const toDir = await resolveDir(toDirPath);
      const toName = to[to.length - 1];

      let writable: { write(b: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> } | undefined;
      try {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        const toHandle = await toDir.getFileHandle(toName, { create: true });
        if (!toHandle.createWritable) throw new Error('copyFile: destination handle is not writable');
        writable = await toHandle.createWritable();

        const file = await fromHandle.getFile();
        const reader = file.stream().getReader();
        while (true) {
          if (signal.aborted) throw new DOMException('aborted', 'AbortError');
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(new Blob([value]));
        }
        await writable.close();
      } catch (err) {
        await writable?.abort?.().catch(() => {});
        await toDir.removeEntry(toName).catch(() => {});
        throw err;
      }
    },

    // Feature-detects handle.move() against the resolved source handle; falls back to a
    // copy-verify-delete sequence otherwise. On any mismatch or error, the source is left
    // intact and any partial/incorrect destination is removed.
    async move(from, to) {
      validatePath(from);
      validatePath(to);
      const fromDir = await resolveDir(from.slice(0, -1));
      const fromName = from[from.length - 1];
      const fromHandle: FileHandleLike = await fromDir.getFileHandle(fromName);

      if (typeof fromHandle.move === 'function') {
        const toDirPath = to.slice(0, -1);
        if (toDirPath.length > 0) await fs.mkdirp(toDirPath);
        const toDir = await resolveDir(toDirPath);
        await fromHandle.move(toDir, to[to.length - 1]);
        return;
      }

      // Fallback: copy, verify the copy matches the source, then delete the source.
      const sourceFile = await fromHandle.getFile();
      const expectedSize = sourceFile.size;
      await fs.copyFile(from, to, new AbortController().signal);

      const kind = await fs.exists(to);
      const actualSize = kind === 'file' ? await fs.size(to) : -1;
      if (kind !== 'file' || actualSize !== expectedSize) {
        await fs.remove(to).catch(() => {});
        throw new Error(`move: verification failed for ${to.join('/')} (expected size ${expectedSize}, got ${actualSize})`);
      }
      await fs.remove(from);
    },
  };

  return fs;
}
