// In-memory fake DirHandleLike/FileHandleLike tree, shared by library-fs/library-source-folder
// style tests (Tasks 7, 8, 9, 12). Supports nested directories, file content (for size/copy
// tests), and per-file simulation of `.move()` being present or absent (for nativeMove
// feature-detection tests).
import type { DirHandleLike, FileHandleLike } from '../src/shared/library-source-folder.ts';

export interface FakeFileOpts {
  /** Initial file bytes. Ignored if `chunks` is given. */
  content?: Uint8Array;
  /** Stream content as these chunks in order, to simulate multi-chunk reads for abort tests. */
  chunks?: Uint8Array[];
  /** If set, getFile() rejects with this error instead of returning a blob. */
  getFileError?: Error;
  /** If set, overrides the blob's reported `.size` without changing the actual bytes streamed —
   *  lets tests simulate a size-mismatch (e.g. for move()'s copy-verify-delete fallback). */
  sizeOverride?: number;
  /** Whether this handle exposes `.move()` — feature-detection toggle. Default false. */
  supportsMove?: boolean;
  lastModified?: number;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export class FakeFileHandle implements FileHandleLike {
  readonly kind = 'file' as const;
  name: string;
  chunks: Uint8Array[];
  getFileError?: Error;
  sizeOverride?: number;
  lastModified: number;
  move?: (dest: DirHandleLike, name?: string) => Promise<void>;
  /** Internal: the directory currently containing this handle, kept in sync by FakeDirHandle. */
  _parent: FakeDirHandle | null = null;

  constructor(name: string, opts: FakeFileOpts = {}) {
    this.name = name;
    this.chunks = opts.chunks ?? [opts.content ?? new Uint8Array()];
    this.getFileError = opts.getFileError;
    this.sizeOverride = opts.sizeOverride;
    this.lastModified = opts.lastModified ?? 0;
    if (opts.supportsMove) {
      this.move = async (dest: DirHandleLike, newName?: string) => {
        const target = dest as FakeDirHandle;
        const name_ = newName ?? this.name;
        this._parent?.deleteChild(this.name);
        this.name = name_;
        target.setChild(name_, this);
      };
    }
  }

  async getFile() {
    if (this.getFileError) throw this.getFileError;
    const chunks = this.chunks;
    const size = this.sizeOverride ?? chunks.reduce((n, c) => n + c.length, 0);
    const name = this.name;
    const lastModified = this.lastModified;
    const blob = {
      size,
      name,
      lastModified,
      stream(): ReadableStream<Uint8Array> {
        let i = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (i < chunks.length) {
              controller.enqueue(chunks[i]);
              i += 1;
            } else {
              controller.close();
            }
          },
        });
      },
      async arrayBuffer() {
        return concat(chunks).buffer;
      },
    };
    return blob as unknown as Blob & { name: string; lastModified: number };
  }

  createWritable?(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }> {
    const self = this;
    const written: Uint8Array[] = [];
    return Promise.resolve({
      async write(b: Blob) {
        written.push(new Uint8Array(await b.arrayBuffer()));
      },
      async close() {
        self.chunks = [concat(written)];
        self.lastModified = Date.now();
      },
      async abort() {
        // Nothing to commit — content stays whatever it was before this write.
      },
    });
  }
}

export class FakeDirHandle implements DirHandleLike {
  readonly kind = 'directory' as const;
  name: string;
  private children = new Map<string, FakeDirHandle | FakeFileHandle>();

  constructor(name: string) {
    this.name = name;
  }

  setChild(name: string, handle: FakeDirHandle | FakeFileHandle): this {
    this.children.set(name, handle);
    if (handle instanceof FakeFileHandle) handle._parent = this;
    return this;
  }

  getChild(name: string): FakeDirHandle | FakeFileHandle | undefined {
    return this.children.get(name);
  }

  deleteChild(name: string): void {
    this.children.delete(name);
  }

  get size(): number {
    return this.children.size;
  }

  async *entries(): AsyncIterable<[string, FakeDirHandle | FakeFileHandle]> {
    for (const [name, handle] of this.children) yield [name, handle];
  }

  async getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandleLike> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error(`not a directory: ${name}`);
      return existing;
    }
    if (!o?.create) throw new Error(`not found: ${name}`);
    const dir = new FakeDirHandle(name);
    this.setChild(name, dir);
    return dir;
  }

  async getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandleLike> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new Error(`not a file: ${name}`);
      return existing;
    }
    if (!o?.create) throw new Error(`not found: ${name}`);
    const file = new FakeFileHandle(name);
    this.setChild(name, file);
    return file;
  }

  async removeEntry(name: string, o?: { recursive?: boolean }): Promise<void> {
    const existing = this.children.get(name);
    if (!existing) throw new Error(`not found: ${name}`);
    if (existing instanceof FakeDirHandle && existing.size > 0 && !o?.recursive) {
      throw new Error(`directory not empty: ${name}`);
    }
    this.children.delete(name);
  }
}

export function makeFakeDir(name = 'root'): FakeDirHandle {
  return new FakeDirHandle(name);
}

export function makeFakeFile(name: string, opts?: FakeFileOpts): FakeFileHandle {
  return new FakeFileHandle(name, opts);
}
