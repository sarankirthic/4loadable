import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, QueueManager } from '../src/background/queue-manager.ts';
import { entry, makeEnv, settle } from './helpers.ts';

const cfg = { maxConcurrent: 3, maxRetries: 2, retryBaseMs: 1000 };

test('state machine allows only valid transitions', () => {
  assert.ok(canTransition('queued', 'starting'));
  assert.ok(canTransition('downloading', 'paused'));
  assert.ok(canTransition('failed', 'queued'));
  assert.ok(!canTransition('queued', 'complete'));   // cannot complete without ever starting
  assert.ok(!canTransition('complete', 'downloading'));
  assert.ok(!canTransition('failed', 'complete'));
});

test('respects the concurrency limit and starts the next item when one finishes', async () => {
  const { env, downloads } = makeEnv();
  const q = new QueueManager(env, cfg);
  q.enqueue([1, 2, 3, 4, 5].map((n) => entry(n)));
  await settle();
  assert.equal(downloads.startCalls.length, 3);
  assert.equal(q.stats().downloading, 3);
  assert.equal(q.stats().queued, 2);

  downloads.complete(1);
  await q.onDownloadChanged(1);
  await settle();
  assert.equal(downloads.startCalls.length, 4);
  assert.ok(q.countActive() <= 3);
});

test('"initiated" is not "complete": status only becomes complete when the browser says so', async () => {
  const { env, downloads } = makeEnv();
  const q = new QueueManager(env, cfg);
  q.enqueue([entry(1)]);
  await settle();
  const it = [...q.items.values()][0];
  assert.equal(it.status, 'downloading');
  await q.poll();
  assert.equal(it.status, 'downloading');
  downloads.complete(1);
  await q.poll();
  assert.equal(it.status, 'complete');
});

test('large batches never exceed the limit', async () => {
  const { env, downloads } = makeEnv();
  const q = new QueueManager(env, { ...cfg, maxConcurrent: 4 });
  q.enqueue(Array.from({ length: 2000 }, (_, i) => entry(i)));
  let peak = 0, loops = 0;
  while (q.stats().complete < 2000 && loops++ < 5000) {
    await settle(2);
    peak = Math.max(peak, q.countActive());
    for (const d of downloads.all.values()) if (d.state === 'in_progress') downloads.complete(d.id);
    await q.poll();
  }
  assert.equal(q.stats().complete, 2000);
  assert.ok(peak <= 4, `peak=${peak}`);
});

test('duplicate queue entries are prevented while active, allowed again after completion', async () => {
  const { env, downloads } = makeEnv();
  const q = new QueueManager(env, cfg);
  assert.deepEqual(q.enqueue([entry(1), entry(1)]), { added: 1, duplicates: 1 });
  await settle();
  assert.deepEqual(q.enqueue([entry(1)]), { added: 0, duplicates: 1 });
  downloads.complete(1);
  await q.poll();
  assert.deepEqual(q.enqueue([entry(1)]), { added: 1, duplicates: 0 });
});

test('transient failures retry with backoff up to the limit, then fail', async () => {
  const { env, downloads, clock } = makeEnv();
  const q = new QueueManager(env, { ...cfg, maxRetries: 2 });
  q.enqueue([entry(1)]);
  await settle();
  downloads.interrupt(1, 'NETWORK_FAILED');
  await q.poll();
  const it = [...q.items.values()][0];
  assert.equal(it.status, 'queued');
  assert.equal(it.attempts, 1);
  await settle();
  assert.equal(downloads.startCalls.length, 1, 'must wait for backoff');
  await clock.advance(1000);
  await settle();
  assert.equal(downloads.startCalls.length, 2);
  downloads.interrupt(2, 'NETWORK_TIMEOUT');
  await q.poll();
  assert.equal(it.attempts, 2);
  await clock.advance(2000);
  await settle();
  assert.equal(downloads.startCalls.length, 3);
  downloads.interrupt(3, 'NETWORK_TIMEOUT');
  await q.poll();
  assert.equal(it.status, 'failed');
  assert.match(it.error!, /too long|Network|connection/i);
});

test('permanent errors fail immediately with a clear message', async () => {
  const { env, downloads } = makeEnv();
  const q = new QueueManager(env, cfg);
  q.enqueue([entry(1)]);
  await settle();
  downloads.interrupt(1, 'SERVER_BAD_CONTENT');
  await q.poll();
  const it = [...q.items.values()][0];
  assert.equal(it.status, 'failed');
  assert.equal(it.attempts, 0);
  assert.match(it.error!, /not found/i);
});

test('errors thrown when starting are classified (invalid filename -> permanent)', async () => {
  const { env, downloads } = makeEnv();
  downloads.failStart = () => 'Invalid filename';
  const q = new QueueManager(env, cfg);
  q.enqueue([entry(1)]);
  await settle();
  assert.equal([...q.items.values()][0].status, 'failed');
});

test('retryFailed re-queues only failed items and resets attempts', async () => {
  const { env, downloads } = makeEnv();
  const q = new QueueManager(env, cfg);
  q.enqueue([entry(1), entry(2)]);
  await settle();
  downloads.interrupt(1, 'SERVER_BAD_CONTENT');
  downloads.complete(2);
  await q.poll();
  assert.equal(q.retryFailed(), 1);
  await settle();
  assert.equal(downloads.startCalls.length, 3);
  assert.equal(q.items.get('g:1700000000002')!.status, 'complete');
});

test('pause / resume / cancel', async () => {
  const { env, downloads } = makeEnv();
  const q = new QueueManager(env, cfg);
  q.enqueue([entry(1), entry(2)]);
  await settle();
  await q.pauseItem('g:1700000000001');
  assert.equal(q.items.get('g:1700000000001')!.status, 'paused');
  assert.equal(downloads.all.get(1)!.paused, true);
  await q.resumeItem('g:1700000000001');
  assert.equal(q.items.get('g:1700000000001')!.status, 'downloading');
  await q.cancelItem('g:1700000000002');
  assert.equal(q.items.get('g:1700000000002')!.status, 'cancelled');
  assert.equal(downloads.all.get(2)!.error, 'USER_CANCELED');
});

test('queue-wide pause stops new starts; resume continues', async () => {
  const { env, downloads } = makeEnv();
  const q = new QueueManager(env, { ...cfg, maxConcurrent: 1 });
  q.enqueue([entry(1), entry(2)]);
  await settle();
  await q.pauseAll();
  downloads.complete(1);
  await q.poll();
  await settle();
  assert.equal(downloads.startCalls.length, 1, 'no new start while paused');
  await q.resumeAll();
  await settle();
  assert.equal(downloads.startCalls.length, 2);
});

test('a download cancelled in the browser UI is recorded as cancelled, not failed', async () => {
  const { env, downloads } = makeEnv();
  const q = new QueueManager(env, cfg);
  q.enqueue([entry(1)]);
  await settle();
  downloads.interrupt(1, 'USER_CANCELED');
  await q.poll();
  assert.equal([...q.items.values()][0].status, 'cancelled');
});

test('queue persists and a restarted worker reconciles with the browser', async () => {
  const { env, downloads, kv } = makeEnv();
  const q1 = new QueueManager(env, cfg);
  q1.enqueue([1, 2, 3, 4].map((n) => entry(n)));
  await settle();
  await q1.flush();
  // while the worker was asleep: #1 finished, #2 failed, #3 still running
  downloads.complete(1);
  downloads.interrupt(2, 'SERVER_FORBIDDEN');

  const finished: string[] = [];
  const q2 = new QueueManager({ ...env, onFinished: (i) => finished.push(`${i.id}:${i.status}`) }, cfg);
  await q2.init();
  await settle();
  assert.equal(q2.items.get('g:1700000000001')!.status, 'complete');
  assert.equal(q2.items.get('g:1700000000002')!.status, 'failed');
  assert.equal(q2.items.get('g:1700000000003')!.status, 'downloading');
  assert.ok(finished.length >= 2);
  assert.ok(Array.isArray((await kv.get('queue')).queue));
});

test('items stuck in "starting" without a download id are re-queued on restart', async () => {
  const { env, kv, downloads } = makeEnv();
  await kv.set({ queue: [{ ...entry(1), status: 'starting', attempts: 0, addedAt: 1, updatedAt: 1 }] });
  const q = new QueueManager(env, cfg);
  await q.init();
  await settle();
  assert.equal(downloads.startCalls.length, 1);
});

test('a download the browser has forgotten is reported as failed', async () => {
  const { env, kv } = makeEnv();
  await kv.set({ queue: [{ ...entry(1), status: 'downloading', downloadId: 999, attempts: 0, addedAt: 1, updatedAt: 1 }] });
  const q = new QueueManager(env, cfg);
  await q.init();
  const it = [...q.items.values()][0];
  assert.equal(it.status, 'failed');
  assert.match(it.error!, /no longer has a record/);
});

test('clearFinished keeps active and failed items', async () => {
  const { env, downloads } = makeEnv();
  const q = new QueueManager(env, cfg);
  q.enqueue([entry(1), entry(2), entry(3)]);
  await settle();
  downloads.complete(1);
  downloads.interrupt(2, 'SERVER_BAD_CONTENT');
  await q.poll();
  q.clearFinished();
  assert.deepEqual([...q.items.keys()].sort(), ['g:1700000000002', 'g:1700000000003']);
});
