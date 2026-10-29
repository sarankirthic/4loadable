// Permission state machine for a user-picked library folder (File System
// Access API), plus a thin IndexedDB-backed store for the chosen directory
// handle (handles can't be persisted in chrome.storage; IndexedDB can hold
// them as structured-clonable values).

export type FolderPermissionState = 'unsupported' | 'disconnected' | 'read' | 'write' | 'needs-reconnect' | 'denied';

export function classifyPermission(o: {
  supported: boolean;
  hasHandle: boolean;
  read?: 'granted' | 'prompt' | 'denied';
  write?: 'granted' | 'prompt' | 'denied';
}): FolderPermissionState {
  if (!o.supported) return 'unsupported';
  if (!o.hasHandle) return 'disconnected';
  if (o.write === 'granted') return 'write';
  if (o.read === 'granted') return 'read';
  if (o.read === 'denied' || o.write === 'denied') return 'denied';
  return 'needs-reconnect'; // prompt, or permission not yet queried
}

/**
 * showDirectoryPicker() throws AbortError both on user cancellation and when
 * Chromium blocks access to a restricted directory (e.g. a drive root); it
 * throws SecurityError for other access-policy blocks. In both cases the
 * most useful guidance is to pick a subfolder instead. Any other error
 * (including a plain user cancel surfaced differently) gets no hint.
 */
export function pickerErrorHint(err: unknown, rootFolderName: string): string | null {
  const name = err instanceof DOMException ? err.name : undefined;
  if (name === 'AbortError' || name === 'SecurityError') {
    return `pick the ${rootFolderName} subfolder instead`;
  }
  return null;
}

/** Soft warning only — never a hard reject. The OS "Downloads" folder is a bad
 * root because the extension would scatter files alongside unrelated downloads. */
export function isLikelyDownloadsRoot(name: string): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === 'downloads';
}

export interface HandleStore<H> {
  get(): Promise<H | null>;
  set(h: H): Promise<void>;
  clear(): Promise<void>;
}

const DEFAULT_DB_NAME = 'library-folder-handle';
const STORE_NAME = 'handles';
const KEY = 'handle';

/** Thin IndexedDB-backed HandleStore. Opens lazily on first use; not unit
 * tested directly (no IndexedDB under node:test) — covered by a fake
 * HandleStore wherever code depends on the HandleStore<H> contract. */
export function indexedDBHandleStore<H>(dbName = DEFAULT_DB_NAME): HandleStore<H> {
  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = fn(tx.objectStore(STORE_NAME));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  return {
    async get() {
      const result = await withStore<H | undefined>('readonly', (store) => store.get(KEY));
      return result ?? null;
    },
    async set(h: H) {
      await withStore<IDBValidKey>('readwrite', (store) => store.put(h, KEY));
    },
    async clear() {
      await withStore<undefined>('readwrite', (store) => store.delete(KEY));
    },
  };
}
