import test from 'node:test';
import assert from 'node:assert/strict';
import { childrenAt, filterEntries, sortEntries, type FlatLeaf } from '../src/shared/library-tree.ts';
import type { LibraryEntry } from '../src/shared/library-types.ts';

const leaves: FlatLeaf[] = [
  { path: ['g', '9', 'images', 'a.png'], size: 100, mediaType: 'image', modifiedAt: 10 },
  { path: ['g', '9', 'images', 'b.png'], size: 200, mediaType: 'image', modifiedAt: 20 },
  { path: ['g', '9', 'video.webm'], size: 50, mediaType: 'video', modifiedAt: 5 },
  { path: ['g', '1', 'c.png'], size: 10, mediaType: 'image', modifiedAt: 1, missing: true },
];

test('childrenAt groups descendants into folders with correct fileCount/totalSize', () => {
  const root = childrenAt(leaves, []);
  const g = root.find((e) => e.name === 'g')!;
  assert.equal(g.kind, 'folder');
  assert.equal(g.fileCount, 4);
  assert.equal(g.totalSize, 360);

  const underG = childrenAt(leaves, ['g']);
  const nine = underG.find((e) => e.name === '9')!;
  assert.equal(nine.fileCount, 3);
  assert.equal(nine.totalSize, 350);

  const underNine = childrenAt(leaves, ['g', '9']);
  const images = underNine.find((e) => e.name === 'images')!;
  assert.equal(images.fileCount, 2);
  assert.equal(images.totalSize, 300);
  const video = underNine.find((e) => e.name === 'video.webm')!;
  assert.equal(video.kind, 'file');
  assert.equal(video.size, 50);
});

test('missing propagates: file leaves carry it through, folders only when fully missing', () => {
  const underG1 = childrenAt(leaves, ['g', '1']);
  const file = underG1.find((e) => e.name === 'c.png')!;
  assert.equal(file.missing, true);

  const root = childrenAt(leaves, []);
  const g = root.find((e) => e.name === 'g')!;
  assert.equal(g.missing, undefined, 'g has a mix of missing and present files, so it is not fully missing');

  const onlyMissing: FlatLeaf[] = [{ path: ['x', 'gone.png'], missing: true }];
  const x = childrenAt(onlyMissing, []).find((e) => e.name === 'x')!;
  assert.equal(x.missing, true, 'a folder whose only files are missing is reported missing');
});

test('sortEntries puts folders first in both directions, unknown size/date last', () => {
  const entries: LibraryEntry[] = [
    { kind: 'file', name: 'b.png', path: ['b.png'], size: 5, modifiedAt: 5 },
    { kind: 'folder', name: 'zz', path: ['zz'], fileCount: 1, totalSize: 1 },
    { kind: 'file', name: 'a.png', path: ['a.png'], size: undefined, modifiedAt: undefined },
    { kind: 'folder', name: 'aa', path: ['aa'], fileCount: 1, totalSize: undefined },
  ];

  const byNameAsc = sortEntries(entries, 'name', 'asc');
  assert.deepEqual(byNameAsc.map((e) => e.kind), ['folder', 'folder', 'file', 'file']);
  assert.deepEqual(byNameAsc.map((e) => e.name), ['aa', 'zz', 'a.png', 'b.png']);

  const byNameDesc = sortEntries(entries, 'name', 'desc');
  assert.deepEqual(byNameDesc.map((e) => e.kind), ['folder', 'folder', 'file', 'file']);
  assert.deepEqual(byNameDesc.map((e) => e.name), ['zz', 'aa', 'b.png', 'a.png']);

  const bySizeAsc = sortEntries(entries, 'size', 'asc');
  const files = bySizeAsc.filter((e) => e.kind === 'file');
  assert.deepEqual(files.map((e) => e.name), ['b.png', 'a.png'], 'unknown size sorts last ascending');
  const folders = bySizeAsc.filter((e) => e.kind === 'folder');
  assert.deepEqual(folders.map((e) => e.name), ['zz', 'aa'], 'unknown totalSize sorts last ascending');

  const bySizeDesc = sortEntries(entries, 'size', 'desc');
  const filesDesc = bySizeDesc.filter((e) => e.kind === 'file');
  assert.deepEqual(filesDesc.map((e) => e.name), ['b.png', 'a.png'], 'unknown size sorts last even descending');
});

test('filterEntries is case-insensitive on name and filters by media type', () => {
  const entries: LibraryEntry[] = [
    { kind: 'folder', name: 'Videos', path: ['Videos'] },
    { kind: 'file', name: 'Cat.PNG', path: ['Cat.PNG'], mediaType: 'image' },
    { kind: 'file', name: 'clip.webm', path: ['clip.webm'], mediaType: 'video' },
  ];

  assert.deepEqual(filterEntries(entries, { query: 'cat' }).map((e) => e.name), ['Cat.PNG']);
  assert.deepEqual(filterEntries(entries, { query: 'VIDEO' }).map((e) => e.name), ['Videos']);
  assert.deepEqual(filterEntries(entries, { types: ['video'] }).map((e) => e.name), ['Videos', 'clip.webm']);
  assert.deepEqual(filterEntries(entries, { types: ['image'] }).map((e) => e.name), ['Videos', 'Cat.PNG']);
});
