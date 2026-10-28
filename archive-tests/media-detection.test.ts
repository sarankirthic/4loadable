import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyExt, getExtension, isAllowedMediaHost, itemFromApiPost, mediaId, mergeMedia, parseFileSize, parseMediaUrl,
  thumbnailOriginalCandidates, thumbnailToOriginal, thumbUrlFor,
} from '../src/shared/media-detection.ts';

test('parses protocol-relative original URLs and canonicalises them', () => {
  const p = parseMediaUrl('//i.4cdn.org/g/1700000000001.jpg?x=1#y');
  assert.deepEqual(p && { url: p.url, board: p.board, tim: p.tim, ext: p.ext, type: p.type, isThumb: p.isThumb },
    { url: 'https://i.4cdn.org/g/1700000000001.jpg', board: 'g', tim: '1700000000001', ext: 'jpg', type: 'image', isThumb: false });
});

test('classifies images, gifs, videos by extension', () => {
  for (const [e, t] of [['jpg', 'image'], ['JPEG', 'image'], ['png', 'image'], ['webp', 'image'], ['avif', 'image'], ['gif', 'gif'], ['webm', 'video'], ['mp4', 'video'], ['gifv', 'video']] as const)
    assert.equal(classifyExt(e), t);
  assert.equal(classifyExt('exe'), null);
  assert.equal(classifyExt('pdf'), null);
});

test('extension detection handles urls, odd names and no extension', () => {
  assert.equal(getExtension('https://i.4cdn.org/g/1.WEBM?x'), 'webm');
  assert.equal(getExtension('archive.tar.gz'), 'gz');
  assert.equal(getExtension('noext'), '');
  assert.equal(getExtension('.hidden'), '');
  assert.equal(getExtension('trailing.'), '');
});

test('thumbnail URLs are recognised and resolved to originals', () => {
  const t = 'https://i.4cdn.org/g/1700000000001s.jpg';
  assert.equal(parseMediaUrl(t)?.isThumb, true);
  assert.equal(thumbnailToOriginal(t, 'png'), 'https://i.4cdn.org/g/1700000000001.png');
  assert.equal(thumbnailToOriginal(t, '.webm'), 'https://i.4cdn.org/g/1700000000001.webm');
  assert.equal(thumbnailToOriginal(t, 'exe'), null);
  assert.equal(thumbnailToOriginal('https://i.4cdn.org/g/1700000000001.png', 'png'), null); // not a thumbnail
  assert.equal(thumbUrlFor('g', '1700000000001'), t);
  assert.ok(thumbnailOriginalCandidates(t).includes('https://i.4cdn.org/g/1700000000001.gif'));
});

test('rejects invalid URLs, unsupported hosts, schemes, credentials, ports and types', () => {
  const bad = [
    '', 'not a url', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'ftp://i.4cdn.org/g/1700000000001.jpg',
    'https://evil.example.com/g/1700000000001.jpg', 'https://i.4cdn.org.evil.com/g/1700000000001.jpg',
    'https://user:pw@i.4cdn.org/g/1700000000001.jpg', 'https://i.4cdn.org:8443/g/1700000000001.jpg',
    'https://i.4cdn.org/g/1700000000001.exe', 'https://i.4cdn.org/g/notatim.jpg', 'https://i.4cdn.org/g/../etc/passwd',
    'https://i.4cdn.org/g/1700000000001s.png', 'https://i.4cdn.org/' + 'a'.repeat(3000),
  ];
  for (const b of bad) assert.equal(parseMediaUrl(b), null, b);
  assert.equal(parseMediaUrl(undefined as any), null);
});

test('host allowlist', () => {
  assert.ok(isAllowedMediaHost('i.4cdn.org'));
  assert.ok(isAllowedMediaHost('IS2.4chan.org'));
  assert.ok(!isAllowedMediaHost('4cdn.org'));
  assert.ok(!isAllowedMediaHost('i.4cdn.org.evil.com'));
  assert.ok(!isAllowedMediaHost('boards.4chan.org'));
});

test('file size parsing uses binary units', () => {
  assert.equal(parseFileSize('1.2 MB'), Math.round(1.2 * 1024 * 1024));
  assert.equal(parseFileSize('850 KB'), 850 * 1024);
  assert.equal(parseFileSize('12 B'), 12);
  assert.equal(parseFileSize('nothing'), undefined);
});

test('API posts become items; deleted and file-less posts are skipped', () => {
  const ok = itemFromApiPost('g', '1000', { no: 1001, filename: 'reply', ext: '.webm', tim: 1700000000102, fsize: 5, w: 1, h: 2, md5: 'x' });
  assert.equal(ok?.type, 'video');
  assert.equal(ok?.url, 'https://i.4cdn.org/g/1700000000102.webm');
  assert.equal(ok?.id, mediaId('g', '1700000000102'));
  assert.equal(itemFromApiPost('g', '1', { no: 2 }), null);
  assert.equal(itemFromApiPost('g', '1', { no: 2, tim: 1700000000103, ext: '.jpg', filedeleted: 1 }), null);
  assert.equal(itemFromApiPost('g', '1', { no: 2, tim: 1700000000103, ext: '.exe' }), null);
});

test('duplicate detection when merging', () => {
  const mk = (tim: string) => itemFromApiPost('g', '1', { no: 1, tim: Number(tim), ext: '.png', filename: 'a' })!;
  const first = mergeMedia([], [mk('1700000000001'), mk('1700000000002'), mk('1700000000001')]);
  assert.equal(first.items.length, 2);
  const second = mergeMedia(first.items, [mk('1700000000002'), mk('1700000000003')]);
  assert.equal(second.added, 1);
  assert.deepEqual(second.items.map((i) => i.order), [0, 1, 2]);
});
