import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createWebServer } from '../src/server/http-server';

test('full task deletion route preserves result, failure, and compatibility semantics', async () => {
  const calls: string[] = [];
  const manager = {
    deleteTask: async (id: string) => {
      calls.push(`complete:${id}`);
      if (id === 'denied') throw Object.assign(new Error('任务输出仍被其他任务使用。'), { status: 409 });
      return id !== 'running';
    },
    deleteTaskDirectory: async (id: string) => { calls.push(`legacy:${id}`); return true; },
    removeTask: async (id: string) => { calls.push(`list-only:${id}`); return true; }
  } as unknown as Parameters<typeof createWebServer>[0];
  const server = createWebServer(manager, { host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const [route, ok] of [['finished/data', true], ['running/data', false], ['finished/output', true], ['finished', true]] as const) {
      const response = await fetch(`${base}/api/tasks/${route}`, { method: 'DELETE' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok });
    }
    const denied = await fetch(`${base}/api/tasks/denied/data`, { method: 'DELETE' });
    assert.equal(denied.status, 409);
    assert.deepEqual(await denied.json(), { error: '任务输出仍被其他任务使用。' });
    assert.deepEqual(calls, ['complete:finished', 'complete:running', 'legacy:finished', 'list-only:finished', 'complete:denied']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
