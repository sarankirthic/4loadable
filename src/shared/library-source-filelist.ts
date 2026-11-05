import type { DirHandleLike, FileHandleLike } from './library-source-folder';

interface TreeDir { kind: 'directory'; children: Map<string, TreeDir | TreeFile> }
interface TreeFile { kind: 'file'; file: unknown }

/** Builds a DirHandleLike tree from a flat file list carrying `webkitRelativePath`
 *  (what `<input webkitdirectory>` and drag-and-drop folder drops both produce),
 *  so it can be fed straight into createFolderSource — same list/stat/thumbnail/open
 *  logic as a real FileSystemDirectoryHandle, just backed by an in-memory snapshot. */
export function buildRootHandle<F extends { webkitRelativePath: string; name: string }>(
  files: Iterable<F>,
): { root: DirHandleLike; rootName: string } {
  const rootChildren = new Map<string, TreeDir | TreeFile>();
  let rootName = 'Folder';
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/').filter(Boolean);
    if (!parts.length) continue;
    rootName = parts[0];
    let node: TreeDir = { kind: 'directory', children: rootChildren };
    for (let i = 1; i < parts.length; i++) {
      const name = parts[i];
      if (i === parts.length - 1) { node.children.set(name, { kind: 'file', file }); continue; }
      let next = node.children.get(name);
      if (!next || next.kind !== 'directory') { next = { kind: 'directory', children: new Map() }; node.children.set(name, next); }
      node = next;
    }
  }
  return { root: toDirHandle(rootName, rootChildren), rootName };
}

function toDirHandle(name: string, children: Map<string, TreeDir | TreeFile>): DirHandleLike {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const [childName, node] of children) {
        yield [childName, node.kind === 'directory' ? toDirHandle(childName, node.children) : toFileHandle(childName, node.file)] as [string, DirHandleLike | FileHandleLike];
      }
    },
    async getDirectoryHandle(n: string) {
      const node = children.get(n);
      if (!node || node.kind !== 'directory') throw new DOMException(`Not found: ${n}`, 'NotFoundError');
      return toDirHandle(n, node.children);
    },
    async getFileHandle(n: string) {
      const node = children.get(n);
      if (!node || node.kind !== 'file') throw new DOMException(`Not found: ${n}`, 'NotFoundError');
      return toFileHandle(n, node.file);
    },
    async removeEntry() { throw new DOMException('This folder was picked without write access.', 'NotAllowedError'); },
  };
}

function toFileHandle(name: string, file: unknown): FileHandleLike {
  return { kind: 'file', name, async getFile() { return file as Awaited<ReturnType<FileHandleLike['getFile']>>; } };
}

export interface PickedDirHandle extends DirHandleLike {
  queryPermission(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** Fallback for browsers/contexts where showDirectoryPicker (File System Access API) is
 *  unavailable — Chrome extension pages are one such case. Uses the much older, universally
 *  supported `<input type="file" webkitdirectory>` to grab a one-time snapshot of a folder's
 *  files: enough for thumbnails and local preview, but read-only and not persisted, so the
 *  folder has to be chosen again each time (the picked handle can't survive a reload). */
export function pickDirectoryViaFileInput(): Promise<PickedDirHandle> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.addEventListener('change', () => {
      const files = input.files;
      if (!files || !files.length) { reject(new DOMException('No folder was selected.', 'AbortError')); return; }
      const { root } = buildRootHandle(Array.from(files));
      resolve({ ...root, queryPermission: async () => 'granted' });
    }, { once: true });
    input.click();
  });
}
