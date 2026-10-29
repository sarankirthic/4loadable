import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSitePermission, hasSitePermission, type PermissionsPort } from '../src/background/site-permissions.ts';

function fakePort(granted: boolean) {
  const registered: { id: string; matches: string[]; js: string[]; runAt: string }[] = [];
  const port: PermissionsPort = {
    request: async () => granted,
    contains: async () => granted,
    registerContentScripts: async (script) => { registered.push(script); },
  };
  return { port, registered };
}

test('requestSitePermission registers the content script when granted', async () => {
  const { port, registered } = fakePort(true);
  const ok = await requestSitePermission('archiveofsins', port);
  assert.equal(ok, true);
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].matches, ['https://archiveofsins.com/*']);
});

test('requestSitePermission does not register when denied', async () => {
  const { port, registered } = fakePort(false);
  const ok = await requestSitePermission('archiveofsins', port);
  assert.equal(ok, false);
  assert.equal(registered.length, 0);
});

test('requestSitePermission returns false for an unknown site', async () => {
  const { port, registered } = fakePort(true);
  const ok = await requestSitePermission('unknown-site', port);
  assert.equal(ok, false);
  assert.equal(registered.length, 0);
});

test('hasSitePermission reflects the port contains() result', async () => {
  const { port: granted } = fakePort(true);
  const { port: denied } = fakePort(false);
  assert.equal(await hasSitePermission('archiveofsins', granted), true);
  assert.equal(await hasSitePermission('archiveofsins', denied), false);
  assert.equal(await hasSitePermission('unknown-site', granted), false);
});

test('ensureSiteScripts re-registers only when permission is still granted', async () => {
  const { ensureSiteScripts } = await import('../src/background/site-permissions.ts');
  const a = fakePort(true); await ensureSiteScripts(a.port); assert.equal(a.registered.length, 1);
  const b = fakePort(false); await ensureSiteScripts(b.port); assert.equal(b.registered.length, 0);
});

test('registerSiteScripts registers only when access is already granted (no prompt, runs without a gesture)', async () => {
  const { registerSiteScripts } = await import('../src/background/site-permissions.ts');
  const a = fakePort(true); assert.equal(await registerSiteScripts('archiveofsins', a.port), true); assert.equal(a.registered.length, 1);
  const b = fakePort(false); assert.equal(await registerSiteScripts('archiveofsins', b.port), false); assert.equal(b.registered.length, 0);
  assert.equal(await registerSiteScripts('nope', a.port), false);
});
