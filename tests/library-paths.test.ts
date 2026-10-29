import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeName, sanitizeEntryName, toRelativeSegments } from '../src/shared/library-paths.ts';

test('isSafeName rejects unsafe segments', () => {
  assert.equal(isSafeName('photo.png'), true);
  assert.equal(isSafeName(''), false);
  assert.equal(isSafeName('.'), false);
  assert.equal(isSafeName('..'), false);
  assert.equal(isSafeName('a/b'), false);
  assert.equal(isSafeName('a\\b'), false);
  assert.equal(isSafeName('a\u0000b'), false);
  assert.equal(isSafeName('a'.repeat(201)), false);
  assert.equal(isSafeName('a'.repeat(200)), true);
});

test('sanitizeEntryName sanitizes like the filename sanitizer', () => {
  assert.equal(sanitizeEntryName('con'), '_con');
  assert.equal(sanitizeEntryName('a/b\\c'), 'a_b_c');
  assert.equal(sanitizeEntryName(''), 'file');
  assert.equal(sanitizeEntryName('  trim  '), 'trim');
});

test('toRelativeSegments converts an absolute path relative to a base folder', () => {
  assert.deepEqual(toRelativeSegments('/Users/me/Downloads/4lodable/g/9/image.png', '/Users/me/Downloads/4lodable'), ['g', '9', 'image.png']);
  assert.deepEqual(toRelativeSegments('/Users/me/Downloads/4lodable', '/Users/me/Downloads/4lodable'), []);
  assert.deepEqual(toRelativeSegments('C:\\Downloads\\4lodable\\g\\9.png', 'C:\\Downloads\\4lodable'), ['g', '9.png']);
});

test('toRelativeSegments returns null when path escapes the base or carries unsafe segments', () => {
  assert.equal(toRelativeSegments('/elsewhere/image.png', '/Users/me/Downloads/4lodable'), null);
  assert.equal(toRelativeSegments('/Users/me/Downloads/4lodableXYZ/image.png', '/Users/me/Downloads/4lodable'), null);
  // Never silently drop an unsafe segment — reject the whole path.
  assert.equal(toRelativeSegments('/base/g/../9/image.png', '/base'), null);
  assert.deepEqual(toRelativeSegments('/base//9/image.png', '/base'), ['9', 'image.png']);
});
