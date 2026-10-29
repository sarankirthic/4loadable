import test from 'node:test';
import assert from 'node:assert/strict';
import { createThumbnailQueue } from '../src/shared/library-thumbnails.ts';

test('never runs more than `concurrency` jobs at once', async () => {
  const queue = createThumbnailQueue(2);
  let active = 0;
  let maxActive = 0;
  const jobs = Array.from({ length: 10 }, () =>
    queue.schedule(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return true;
    }),
  );
  await Promise.all(jobs);
  assert.ok(maxActive <= 2, `expected maxActive <= 2, got ${maxActive}`);
});

test('all results land, including rejections, matched to their own job', async () => {
  const queue = createThumbnailQueue(3);
  const results = await Promise.allSettled([
    queue.schedule(async () => 1),
    queue.schedule(async () => {
      throw new Error('boom');
    }),
    queue.schedule(async () => 3),
    queue.schedule(async () => 4),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal((results[0] as PromiseFulfilledResult<number>).value, 1);
  assert.equal(results[1].status, 'rejected');
  assert.equal((results[1] as PromiseRejectedResult).reason.message, 'boom');
  assert.equal(results[2].status, 'fulfilled');
  assert.equal((results[2] as PromiseFulfilledResult<number>).value, 3);
  assert.equal(results[3].status, 'fulfilled');
  assert.equal((results[3] as PromiseFulfilledResult<number>).value, 4);
});

test('cancelAll() rejects not-yet-started jobs with a distinguishable error, leaves running jobs alone', async () => {
  const queue = createThumbnailQueue(1);
  let firstStarted = false;
  const first = queue.schedule(async () => {
    firstStarted = true;
    await new Promise((r) => setTimeout(r, 20));
    return 'first-done';
  });
  const second = queue.schedule(async () => 'second');
  const third = queue.schedule(async () => 'third');

  assert.ok(firstStarted, 'first job should have started synchronously-ish before cancelAll');
  queue.cancelAll();

  await assert.rejects(second, (err: unknown) => err instanceof Error && err.name === 'ThumbnailQueueCancelledError');
  await assert.rejects(third, (err: unknown) => err instanceof Error && err.name === 'ThumbnailQueueCancelledError');
  // The already-running job is not cancelled — it still resolves normally.
  assert.equal(await first, 'first-done');
});
