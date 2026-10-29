import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTargetPath, ensureUniquePaths, isSafeRelativePath, sanitizeFilename, sanitizeFolderPath, sanitizeSegment,
} from '../src/shared/filename-utils.ts';
import type { DownloadOptions, MediaItem } from '../src/shared/types.ts';

const opts: DownloadOptions = {
  rootFolder: '4lodable', subfolder: '', organize: 'board-thread-type', filenameMode: 'original',
  filenameTemplate: '{post}_{original}', duplicates: 'rename', saveAs: false, writeManifest: true,
};
const item = (o: Partial<MediaItem> = {}): MediaItem => ({
  id: 'fourchan:g:1700000000001', url: 'https://i.4cdn.org/g/1700000000001.png', site: 'fourchan', board: 'g', threadId: '1000', postNo: '1001',
  tim: '1700000000001', ext: 'png', type: 'image', originalName: 'cat', order: 0, ...o,
});

test('sanitizeSegment strips separators, control chars, and traversal', () => {
  assert.equal(sanitizeSegment('a/b\\c:d*e?"<>|'), 'a_b_c_d_e_____'.replace(/_+$/, (m) => m).slice(0, 14));
  assert.equal(sanitizeSegment('..'), 'file');
  assert.equal(sanitizeSegment('...hidden'), 'hidden');
  assert.equal(sanitizeSegment('name. '), 'name');
  assert.equal(sanitizeSegment('a\u0000b\u202ec'), 'a_b_c');
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('nul.txt'), '_nul.txt');
  assert.equal(sanitizeSegment(''), 'file');
  assert.equal(sanitizeSegment(null), 'file');
});

test('sanitizeFolderPath removes traversal and absolute roots', () => {
  assert.deepEqual(sanitizeFolderPath('../../etc/passwd'), ['etc', 'passwd']);
  assert.deepEqual(sanitizeFolderPath('/abs/path//x/./y'), ['abs', 'path', 'x', 'y']);
  assert.deepEqual(sanitizeFolderPath('C:\\Windows\\System32'), ['C_', 'Windows', 'System32']);
  assert.deepEqual(sanitizeFolderPath(''), []);
});

test('sanitizeFilename preserves a safe extension and truncates long names', () => {
  assert.equal(sanitizeFilename('my pic', 'PNG'), 'my pic.png');
  assert.equal(sanitizeFilename('x', 'p/n\\g'), 'x.png');
  const long = sanitizeFilename('a'.repeat(500), 'webm', 50);
  assert.equal(long.length, 55);
  assert.ok(long.endsWith('.webm'));
});

test('buildTargetPath organises by site/board/thread/type', () => {
  assert.equal(buildTargetPath(item(), opts, { index: 1, date: '2026-10-25' }).path, '4lodable/fourchan/g/1000/images/cat.png');
  assert.equal(buildTargetPath(item({ type: 'gif', ext: 'gif' }), opts, { index: 1, date: 'd' }).path, '4lodable/fourchan/g/1000/gifs/cat.gif');
  assert.equal(buildTargetPath(item({ type: 'video', ext: 'webm' }), opts, { index: 1, date: 'd' }).path, '4lodable/fourchan/g/1000/videos/cat.webm');
  assert.equal(buildTargetPath(item(), { ...opts, organize: 'flat' }, { index: 1, date: 'd' }).path, '4lodable/cat.png');
  assert.equal(buildTargetPath(item(), { ...opts, organize: 'board-thread', subfolder: 'my/stuff' }, { index: 1, date: 'd' }).path, '4lodable/my/stuff/fourchan/g/1000/cat.png');
});

test('filename modes: server name and template', () => {
  assert.equal(buildTargetPath(item(), { ...opts, filenameMode: 'server' }, { index: 1, date: 'd' }).path, '4lodable/fourchan/g/1000/images/1700000000001.png');
  const t = buildTargetPath(item(), { ...opts, filenameMode: 'template', filenameTemplate: '{board}-{thread}-{post}-{index}_{original}' }, { index: 7, date: 'd' });
  assert.equal(t.path, '4lodable/fourchan/g/1000/images/g-1000-1001-0007_cat.png');
});

test('malicious original names and roots cannot escape the download folder', () => {
  const p = buildTargetPath(item({ originalName: '../../../evil' }), { ...opts, rootFolder: '../..//x' }, { index: 1, date: 'd' }).path;
  assert.ok(isSafeRelativePath(p), p);
  assert.ok(!p.includes('..'));
  assert.ok(p.endsWith('.png'));
  const t = buildTargetPath(item({ originalName: 'a/b' }), { ...opts, filenameMode: 'template', filenameTemplate: '../{original}' }, { index: 1, date: 'd' }).path;
  assert.ok(isSafeRelativePath(t), t);
});

test('very long paths are shortened', () => {
  const p = buildTargetPath(item({ originalName: 'x'.repeat(400) }), { ...opts, subfolder: 'y'.repeat(90) }, { index: 1, date: 'd' }).path;
  assert.ok(p.length <= 250, String(p.length));
  assert.ok(p.endsWith('.png'));
});

test('ensureUniquePaths resolves collisions case-insensitively and against taken paths', () => {
  assert.deepEqual(ensureUniquePaths(['a/x.png', 'a/X.png', 'a/x.png', 'a/y.png']), ['a/x.png', 'a/X-2.png', 'a/x-3.png', 'a/y.png']);
  assert.deepEqual(ensureUniquePaths(['a/x.png'], new Set(['a/x.png'])), ['a/x-2.png']);
});

test('isSafeRelativePath', () => {
  for (const ok of ['a/b.png', 'x.png']) assert.ok(isSafeRelativePath(ok));
  for (const bad of ['', '/abs/x.png', 'C:/x.png', '../x.png', 'a/../x.png', 'a//x.png', 'a/b\u0000.png', 'a/b?.png']) assert.ok(!isSafeRelativePath(bad), bad);
});
