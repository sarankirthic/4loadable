import test from 'node:test';
import assert from 'node:assert/strict';
import { planDownloads } from '../src/background/download-manager.ts';
import type { MediaItem } from '../src/shared/types.ts';

const item = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: 'archiveofsins:h:1792171898073007', url: 'https://archiveofsins.com/data/h/image/1792/17/1792171898073007.jpg',
  site: 'archiveofsins', board: 'h', threadId: '8968486', postNo: '8968486', tim: '1792171898073007', ext: 'jpg', type: 'image',
  originalName: 'photo', order: 0, ...over,
} as MediaItem);

const opts: any = { organize: 'board-thread-type', rootFolder: '4loadable', subfolder: '', filenameMode: 'original', duplicates: 'uniquify', saveAs: false, writeManifest: false };
const base = { options: opts, settings: { fullResOnly: true }, history: {}, batchId: 'b1', date: '2026-10-28' };

test('archive items are accepted by the download planner', () => {
  const plan = planDownloads({ ...base, items: [item()] });
  assert.equal(plan.skipped.length, 0, JSON.stringify(plan.skipped));
  assert.equal(plan.entries.length, 1);
  assert.ok(plan.entries[0].path.startsWith('4loadable/archiveofsins/h/8968486/images/'));
});

test('archive thumbnails are still rejected as non-full-res', () => {
  const plan = planDownloads({ ...base, items: [item({ url: 'https://archiveofsins.com/data/h/thumb/1792/17/1792171898073007s.jpg' })] });
  assert.equal(plan.entries.length, 0);
});

test('a 4chan-looking URL labelled as archive is rejected', () => {
  const plan = planDownloads({ ...base, items: [item({ url: 'https://i.4cdn.org/h/1792171898073007.jpg' })] });
  assert.equal(plan.entries.length, 0);
});
