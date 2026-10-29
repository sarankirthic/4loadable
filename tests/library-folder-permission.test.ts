import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPermission,
  pickerErrorHint,
  isLikelyDownloadsRoot,
  indexedDBHandleStore,
  type HandleStore,
} from '../src/shared/library-folder-store.ts';

test('classifyPermission: unsupported regardless of other fields', () => {
  assert.equal(classifyPermission({ supported: false, hasHandle: true, read: 'granted', write: 'granted' }), 'unsupported');
  assert.equal(classifyPermission({ supported: false, hasHandle: false }), 'unsupported');
});

test('classifyPermission: disconnected when no handle', () => {
  assert.equal(classifyPermission({ supported: true, hasHandle: false }), 'disconnected');
  assert.equal(classifyPermission({ supported: true, hasHandle: false, read: 'granted' }), 'disconnected');
});

test('classifyPermission: read when read granted and write not granted', () => {
  assert.equal(classifyPermission({ supported: true, hasHandle: true, read: 'granted', write: 'prompt' }), 'read');
  assert.equal(classifyPermission({ supported: true, hasHandle: true, read: 'granted' }), 'read');
});

test('classifyPermission: write when write granted', () => {
  assert.equal(classifyPermission({ supported: true, hasHandle: true, read: 'granted', write: 'granted' }), 'write');
  assert.equal(classifyPermission({ supported: true, hasHandle: true, write: 'granted' }), 'write');
});

test('classifyPermission: needs-reconnect on prompt', () => {
  assert.equal(classifyPermission({ supported: true, hasHandle: true, read: 'prompt' }), 'needs-reconnect');
  assert.equal(classifyPermission({ supported: true, hasHandle: true, read: 'prompt', write: 'prompt' }), 'needs-reconnect');
});

test('classifyPermission: denied', () => {
  assert.equal(classifyPermission({ supported: true, hasHandle: true, read: 'denied', write: 'denied' }), 'denied');
  assert.equal(classifyPermission({ supported: true, hasHandle: true, read: 'denied' }), 'denied');
});

test('pickerErrorHint: returns hint for AbortError and SecurityError', () => {
  const root = '4chan-Downloads';
  assert.equal(pickerErrorHint(new DOMException('aborted', 'AbortError'), root), `pick the ${root} subfolder instead`);
  assert.equal(pickerErrorHint(new DOMException('blocked', 'SecurityError'), root), `pick the ${root} subfolder instead`);
});

test('pickerErrorHint: returns null for unrelated errors', () => {
  const root = '4chan-Downloads';
  assert.equal(pickerErrorHint(new DOMException('nope', 'NotFoundError'), root), null);
  assert.equal(pickerErrorHint(new Error('boom'), root), null);
  assert.equal(pickerErrorHint('not an error object', root), null);
  assert.equal(pickerErrorHint(undefined, root), null);
});

test('isLikelyDownloadsRoot: true for Downloads/downloads, false otherwise', () => {
  assert.equal(isLikelyDownloadsRoot('Downloads'), true);
  assert.equal(isLikelyDownloadsRoot('downloads'), true);
  assert.equal(isLikelyDownloadsRoot('DOWNLOADS'), true);
  assert.equal(isLikelyDownloadsRoot(' Downloads '), true);
  assert.equal(isLikelyDownloadsRoot('4chan-Downloads'), false);
  assert.equal(isLikelyDownloadsRoot(''), false);
});

test('indexedDBHandleStore: constructs a store implementing the HandleStore contract', () => {
  const store = indexedDBHandleStore<{ id: string }>('test-db');
  assert.equal(typeof store.get, 'function');
  assert.equal(typeof store.set, 'function');
  assert.equal(typeof store.clear, 'function');
});

// A fake HandleStore stands in for the IndexedDB-backed one in tests that
// exercise code depending on the HandleStore<H> contract (real IndexedDB
// isn't available under node:test).
function fakeHandleStore<H>(): HandleStore<H> & { backing: H | null } {
  const state: { value: H | null } = { value: null };
  return {
    backing: null,
    async get() { return state.value; },
    async set(h: H) { state.value = h; },
    async clear() { state.value = null; },
  };
}

test('fake HandleStore round-trips get/set/clear like the real contract would', async () => {
  const store = fakeHandleStore<{ id: string }>();
  assert.equal(await store.get(), null);
  await store.set({ id: 'a' });
  assert.deepEqual(await store.get(), { id: 'a' });
  await store.clear();
  assert.equal(await store.get(), null);
});
