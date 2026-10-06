import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskSlotLimiter } from '../src/main/concurrency';

test('waiting task cancellation releases the queue without affecting active tasks', async () => {
  const limiter = new TaskSlotLimiter(1);
  const release = await limiter.acquire();
  const controller = new AbortController();
  const cancelled = limiter.acquire(controller.signal);
  const rejection = assert.rejects(cancelled, /cancelled/);
  let nextStarted = false;
  const next = limiter.acquire().then((permit) => { nextStarted = true; return permit; });
  controller.abort();
  await rejection;
  assert.equal(nextStarted, false);
  release();
  const releaseNext = await next;
  assert.equal(nextStarted, true);
  releaseNext();
  releaseNext();
  const releaseFinal = await limiter.acquire();
  releaseFinal();
});

test('increasing concurrency grants waiting work and decreasing it drains safely', async () => {
  const limiter = new TaskSlotLimiter(1);
  const first = await limiter.acquire();
  const secondPromise = limiter.acquire();
  limiter.setLimit(2);
  const second = await secondPromise;
  limiter.setLimit(1);
  let thirdStarted = false;
  const thirdPromise = limiter.acquire().then((release) => { thirdStarted = true; return release; });
  first();
  await Promise.resolve();
  assert.equal(thirdStarted, false);
  second();
  const third = await thirdPromise;
  third();
});
