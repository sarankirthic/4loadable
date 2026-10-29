import test from 'node:test';
import assert from 'node:assert/strict';
import { fourchanAdapter } from '../src/adapters/fourchan.ts';

test('fourchan adapter matches 4chan hosts only', () => {
  assert.equal(fourchanAdapter.id, 'fourchan');
  assert.equal(fourchanAdapter.matches(new URL('https://boards.4chan.org/g/')), true);
  assert.equal(fourchanAdapter.matches(new URL('https://boards.4channel.org/g/')), true);
  assert.equal(fourchanAdapter.matches(new URL('https://archiveofsins.com/h/')), false);
});

test('fourchan adapter detectPage matches the existing detectPage shape', () => {
  const p = fourchanAdapter.detectPage(new URL('https://boards.4chan.org/g/thread/12345'), 'a title');
  assert.deepEqual(p, { kind: 'thread', board: 'g', threadId: '12345', url: 'https://boards.4chan.org/g/thread/12345', title: 'a title', site: 'fourchan' });
});
