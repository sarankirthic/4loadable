import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveofsinsAdapter } from '../src/adapters/archiveofsins.ts';

const FULL = 'https://archiveofsins.com/data/h/image/1792/17/1792171898073007.jpg';
const THUMB = 'https://archiveofsins.com/data/h/thumb/1792/17/1792171898073007s.jpg';

test('parses a real full-size image URL', () => {
  const p = archiveofsinsAdapter.parseMediaUrl(FULL);
  assert.deepEqual(p && { url: p.url, host: p.host, board: p.board, tim: p.tim, ext: p.ext, type: p.type, isThumb: p.isThumb },
    { url: FULL, host: 'archiveofsins.com', board: 'h', tim: '1792171898073007', ext: 'jpg', type: 'image', isThumb: false });
});

test('parses the matching thumbnail URL as isThumb', () => {
  const p = archiveofsinsAdapter.parseMediaUrl(THUMB);
  assert.equal(p?.isThumb, true);
  assert.equal(p?.tim, '1792171898073007');
});

test('rejects a different host', () => {
  assert.equal(archiveofsinsAdapter.parseMediaUrl('https://evil.example/data/h/image/1792/17/1792171898073007.jpg'), null);
});

test('rejects path traversal', () => {
  assert.equal(archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com/data/h/image/../../etc/passwd'), null);
  assert.equal(archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com/data/h/image/1792/17/../../../1792171898073007.jpg'), null);
});

test('rejects a timestamp-prefix directory that does not match the filename', () => {
  assert.equal(archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com/data/h/image/0000/00/1792171898073007.jpg'), null);
});

test('rejects credentials in the URL', () => {
  assert.equal(archiveofsinsAdapter.parseMediaUrl('https://user:pass@archiveofsins.com/data/h/image/1792/17/1792171898073007.jpg'), null);
});

test('rejects a non-standard port', () => {
  assert.equal(archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com:8443/data/h/image/1792/17/1792171898073007.jpg'), null);
});

test('rejects http (https only)', () => {
  assert.equal(archiveofsinsAdapter.parseMediaUrl('http://archiveofsins.com/data/h/image/1792/17/1792171898073007.jpg'), null);
});

test('rejects an unsupported extension', () => {
  assert.equal(archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com/data/h/image/1792/17/1792171898073007.exe'), null);
});

test('rejects image-kind paths with an s-suffix and thumb-kind paths without one', () => {
  assert.equal(archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com/data/h/image/1792/17/1792171898073007s.jpg'), null);
  assert.equal(archiveofsinsAdapter.parseMediaUrl('https://archiveofsins.com/data/h/thumb/1792/17/1792171898073007.jpg'), null);
});

test('host allowlist', () => {
  assert.ok(archiveofsinsAdapter.allowedMediaHosts('archiveofsins.com'));
  assert.ok(!archiveofsinsAdapter.allowedMediaHosts('evil.example'));
  assert.ok(!archiveofsinsAdapter.allowedMediaHosts('sub.archiveofsins.com'));
});

test('matches archiveofsins.com only', () => {
  assert.equal(archiveofsinsAdapter.matches(new URL('https://archiveofsins.com/h/')), true);
  assert.equal(archiveofsinsAdapter.matches(new URL('https://boards.4chan.org/g/')), false);
});

test('detectPage: thread', () => {
  const p = archiveofsinsAdapter.detectPage(new URL('https://archiveofsins.com/h/thread/8968486/'), 't');
  assert.deepEqual(p, { kind: 'thread', board: 'h', threadId: '8968486', url: 'https://archiveofsins.com/h/thread/8968486/', title: 't', site: 'archiveofsins' });
});

test('detectPage: board index', () => {
  const p = archiveofsinsAdapter.detectPage(new URL('https://archiveofsins.com/h/'), 't');
  assert.deepEqual(p, { kind: 'board', board: 'h', url: 'https://archiveofsins.com/h/', title: 't', site: 'archiveofsins' });
  const paged = archiveofsinsAdapter.detectPage(new URL('https://archiveofsins.com/h/2/'), 't');
  assert.equal(paged.kind, 'board');
});

test('detectPage: unsupported (search page, gallery, api)', () => {
  assert.equal(archiveofsinsAdapter.detectPage(new URL('https://archiveofsins.com/h/search/text/foo/'), 't').kind, 'unsupported');
  assert.equal(archiveofsinsAdapter.detectPage(new URL('https://archiveofsins.com/h/gallery/'), 't').kind, 'unsupported');
  assert.equal(archiveofsinsAdapter.detectPage(new URL('https://archiveofsins.com/_/api/chan/thread/'), 't').kind, 'unsupported');
  assert.equal(archiveofsinsAdapter.detectPage(new URL('https://boards.4chan.org/h/thread/1/'), 't').kind, 'unsupported');
});
