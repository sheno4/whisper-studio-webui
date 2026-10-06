import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { TaskRecord } from '../src/shared/types';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const waitFor = async (condition: () => boolean, message: string) => {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const link = (number: number) => `https://www.youtube.com/watch?v=queue${String(number).padStart(6, '0')}`;

test('queue responds to live additions and capacity changes without waiting for a running task', { timeout: 8000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-live-queue-'));
  const previousDataDir = process.env.WHISPER_DATA_DIR;
  const previousOutputDir = process.env.WHISPER_OUTPUT_DIR;
  process.env.WHISPER_DATA_DIR = path.join(root, 'data');
  process.env.WHISPER_OUTPUT_DIR = path.join(root, 'outputs');
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.WHISPER_DATA_DIR;
    else process.env.WHISPER_DATA_DIR = previousDataDir;
    if (previousOutputDir === undefined) delete process.env.WHISPER_OUTPUT_DIR;
    else process.env.WHISPER_OUTPUT_DIR = previousOutputDir;
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { TaskManager } = await import('../src/main/task-manager');

  const fixture = (subtest: TestContext) => {
    const manager = new TaskManager() as any;
    manager.settings.maxConcurrentDownloads = 1;
    manager.settings.maxConcurrentTranscriptions = 1;
    manager.settings.maxConcurrentTranslations = 1;
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const starts = new Map<string, number>();
    // Replace only task execution: the public enqueue/settings methods and real
    // queue scheduler still run, without Python, GPU, network, or media fixtures.
    subtest.mock.method(manager, 'executeTask', async (task: TaskRecord) => {
      task.status = 'downloading';
      starts.set(task.id, (starts.get(task.id) ?? 0) + 1);
      const gate = deferred();
      gates.set(task.id, gate);
      await gate.promise;
      task.status = 'completed';
    });
    subtest.mock.method(manager, 'refreshEnvironmentInBackground', async () => {});
    const close = async () => {
      // Release every fake task even if an assertion fails, then let shutdown
      // stop the real scheduler before removing the isolated temporary store.
      for (const gate of gates.values()) gate.resolve();
      await manager.shutdown();
      await manager.queueDrain;
    };
    return { manager, gates, starts, close };
  };

  await t.test('a second link starts while the first link is still running and capacity is available', async (subtest) => {
    const { manager, gates, starts, close } = fixture(subtest);
    try {
      const [first] = manager.addLinkTasks([link(1)]);
      await waitFor(() => starts.has(first.id), 'The first task did not start');
      const [second] = manager.addLinkTasks([link(2)]);
      await waitFor(() => starts.has(second.id), 'A newly added task must start before the running task finishes');
      assert.equal(first.status, 'downloading');
      assert.equal(second.status, 'downloading');
      assert.equal(gates.size, 2);
      assert.deepEqual([...starts.values()], [1, 1]);
    } finally {
      await close();
    }
  });

  await t.test('a live addition waits at full capacity and starts once a slot is released without duplicate execution', async (subtest) => {
    const { manager, gates, starts, close } = fixture(subtest);
    try {
      const initial = manager.addLinkTasks([link(3), link(4), link(5)]);
      await waitFor(() => starts.size === 3, 'The initial tasks did not occupy the available capacity');
      const [queued] = manager.addLinkTasks([link(6)]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(queued.status, 'queued');
      assert.equal(starts.has(queued.id), false);
      gates.get(initial[0].id)!.resolve();
      await waitFor(() => starts.has(queued.id), 'A queued live addition did not start when capacity became available');
      assert.equal(initial[1].status, 'downloading');
      assert.equal(initial[2].status, 'downloading');
      assert.equal(starts.size, 4);
      assert.ok([...starts.values()].every((count) => count === 1));
      for (const gate of gates.values()) gate.resolve();
      await manager.processQueue();
      assert.ok([...initial, queued].every((task) => task.status === 'completed'));
      assert.ok([...starts.values()].every((count) => count === 1));
    } finally {
      await close();
    }
  });

  await t.test('saving a larger concurrency limit starts an already queued task while existing tasks remain running', async (subtest) => {
    const { manager, gates, starts, close } = fixture(subtest);
    try {
      const tasks = manager.addLinkTasks([link(7), link(8), link(9), link(10)]);
      await waitFor(() => starts.size === 3, 'The initial tasks did not occupy the available capacity');
      assert.equal(tasks[3].status, 'queued');
      // WHISPER_DATA_DIR/WHISPER_OUTPUT_DIR point inside this test's temporary
      // directory; saveSettings cannot touch the application's real settings.
      await manager.saveSettings({ ...manager.getSettings(), maxConcurrentDownloads: 2 });
      await waitFor(() => starts.has(tasks[3].id), 'Saving a larger limit must wake the queue immediately');
      assert.ok(tasks.every((task) => task.status === 'downloading'));
      assert.equal(gates.size, 4);
      assert.ok([...starts.values()].every((count) => count === 1));
    } finally {
      await close();
    }
  });
});
