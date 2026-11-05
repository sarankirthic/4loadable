import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_MAX_BYTES, isManifestName, parseThreadManifest, findManifestRecord, manifestDirFor,
} from '../src/shared/library-manifest.ts';

const validJson = JSON.stringify({
  generatedAt: '2026-10-29T00:00:00.000Z',
  files: [
    { sourceUrl: 'https://i.4cdn.org/g/1.png', originalFilename: 'orig.png', mediaType: 'image', postNumber: '123', savedPath: '4lodable/fourchan/g/9/images/orig.png', status: 'complete' },
    { sourceUrl: 'https://i.4cdn.org/g/2.png', originalFilename: 'orig.png', mediaType: 'image', postNumber: '124', savedPath: '4lodable/fourchan/g/9/images/orig-2.png', status: 'complete' },
  ],
});

test('parseThreadManifest parses a valid manifest', () => {
  const m = parseThreadManifest(validJson);
  assert.ok(m);
  assert.equal(m!.files.length, 2);
  assert.equal(m!.files[0].postNumber, '123');
  assert.equal(m!.files[0].savedPath, '4lodable/fourchan/g/9/images/orig.png');
});

test('parseThreadManifest returns null on malformed JSON', () => {
  assert.equal(parseThreadManifest('{not json'), null);
});

test('parseThreadManifest returns null on oversized text without calling JSON.parse', () => {
  const originalParse = JSON.parse;
  let called = false;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { called = true; return originalParse(...args); }) as typeof JSON.parse;
  try {
    const huge = 'x'.repeat(MANIFEST_MAX_BYTES + 1);
    assert.equal(parseThreadManifest(huge), null);
    assert.equal(called, false, 'JSON.parse must not be called for oversized text');
  } finally {
    JSON.parse = originalParse;
  }
});

test('parseThreadManifest returns null on wrong shape', () => {
  assert.equal(parseThreadManifest('null'), null);
  assert.equal(parseThreadManifest('[]'), null);
  assert.equal(parseThreadManifest('{}'), null);
  assert.equal(parseThreadManifest(JSON.stringify({ files: 'nope' })), null);
  assert.equal(parseThreadManifest(JSON.stringify({ files: [{ sourceUrl: 'u' }] })), null, 'missing required fields on a record');
});

test('isManifestName accepts manifest.json and renamed copies, rejects others', () => {
  assert.ok(isManifestName('manifest.json'));
  assert.ok(isManifestName('MANIFEST.JSON'));
  assert.ok(isManifestName('manifest (1).json'));
  assert.ok(isManifestName('manifest (23).json'));
  assert.ok(!isManifestName('manifest.json.bak'));
  assert.ok(!isManifestName('manifests.json'));
  assert.ok(!isManifestName('other.json'));
});

test('findManifestRecord matches by saved file name (last segment), not original filename', () => {
  const m = parseThreadManifest(validJson);
  const found = findManifestRecord(m, 'orig-2.png');
  assert.ok(found);
  assert.equal(found!.postNumber, '124');
  assert.equal(findManifestRecord(m, 'orig.png')!.postNumber, '123');
  assert.equal(findManifestRecord(m, 'does-not-exist.png'), undefined);
  assert.equal(findManifestRecord(null, 'orig.png'), undefined);
});

test('manifestDirFor collapses the media-type leaf into the thread folder', () => {
  assert.deepEqual(manifestDirFor(['g', '123', 'images']), ['g', '123']);
  assert.deepEqual(manifestDirFor(['g', '123', 'gifs']), ['g', '123']);
  assert.deepEqual(manifestDirFor(['g', '123', 'videos']), ['g', '123']);
  assert.deepEqual(manifestDirFor(['g', '123']), ['g', '123']);
  assert.deepEqual(manifestDirFor(['g', '123', 'videos', 'sub']), ['g', '123', 'videos', 'sub']);
});
