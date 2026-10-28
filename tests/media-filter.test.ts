import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FILTER, countByType, filterAndSort, formatBytes, invertSelection, selectAll, selectRange, selectType, selectionSummary } from '../src/shared/media-filter.ts';
import type { MediaItem } from '../src/shared/types.ts';

const mk = (n: number, o: Partial<MediaItem> = {}): MediaItem => ({
  id: 'g:' + n, url: 'u', board: 'g', threadId: '10', postNo: String(100 + n), tim: String(1700000000000 + n), ext: 'png', type: 'image', originalName: `file${n}`, order: n, ...o,
});
const items = [mk(1, { size: 300 }), mk(2, { type: 'gif', ext: 'gif', size: 100, originalName: 'Zeta' }), mk(3, { type: 'video', ext: 'webm', originalName: 'alpha' }), mk(4, { size: 200, threadId: '5' })];
const ids = (l: MediaItem[]) => l.map((i) => i.id.slice(2)).join('');

test('filter by type and search (filename, post number with >>, ext)', () => {
  assert.equal(ids(filterAndSort(items, { ...DEFAULT_FILTER, types: { image: true, gif: false, video: false } })), '14');
  assert.equal(ids(filterAndSort(items, { ...DEFAULT_FILTER, query: 'ZETA' })), '2');
  assert.equal(ids(filterAndSort(items, { ...DEFAULT_FILTER, query: '>>103' })), '3');
  assert.equal(ids(filterAndSort(items, { ...DEFAULT_FILTER, query: 'webm' })), '3');
  assert.equal(ids(filterAndSort(items, { ...DEFAULT_FILTER, query: 'nomatch' })), '');
});

test('sorting: post order, name, type, size (unknown last in both directions), thread', () => {
  const s = (sort: any, desc = false) => ids(filterAndSort(items, { ...DEFAULT_FILTER, sort, desc }));
  assert.equal(s('post'), '1234'); assert.equal(s('post', true), '4321');
  assert.equal(s('name'), '3142'); // alpha, file1, file4, Zeta
  assert.equal(s('type'), '1423');
  assert.equal(s('size'), '2413'); assert.equal(s('size', true), '1423');
  assert.equal(s('thread'), '4123');
});

test('select all / by type / invert / range', () => {
  assert.equal(selectAll(items).size, 4);
  assert.deepEqual([...selectType(items, 'video')], ['g:3']);
  const inv = invertSelection(items, new Set(['g:1', 'g:2']));
  assert.deepEqual([...inv].sort(), ['g:3', 'g:4']);
  assert.deepEqual([...selectRange(items, 3, 1, new Set(), true)].sort(), ['g:2', 'g:3', 'g:4']);
  assert.deepEqual([...selectRange(items, 0, 2, new Set(['g:1', 'g:2', 'g:3']), false)], []);
  assert.equal(selectRange(items, -5, 99, new Set(), true).size, 4, 'out-of-range indices are clamped');
});

test('selection summary reports bytes only for known sizes', () => {
  assert.deepEqual(selectionSummary(items, new Set(['g:1', 'g:3'])), { count: 2, bytes: 300, knownSizes: 1 });
  assert.deepEqual(countByType(items), { image: 2, gif: 1, video: 1 });
  assert.equal(formatBytes(0), '0 B'); assert.equal(formatBytes(1536), '1.5 KB'); assert.equal(formatBytes(5 * 1024 ** 2), '5.0 MB');
});
