import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PythonWorkerClient } from '../src/main/python-worker';
import type { WorkerResultPayload, WorkerTaskRequest } from '../src/shared/types';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const waitFor = async (condition: () => boolean) => {
  const until = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > until) throw new Error('Concurrent task did not reach expected stage');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const result = (request: WorkerTaskRequest): WorkerResultPayload => ({
  taskId: request.taskId, sourceType: request.sourceType, input: request.input,
  displayName: request.taskId, outputDir: request.outputDir,
  transcriptText: 'fixture', transcriptSegments: [], outputFiles: {},
  preparedMedia: {
    transcriptInputPath: 'fixture.wav',
    mediaInfo: { downloadBehavior: request.downloadBehavior, requestedQuality: request.videoQuality }
  }
});

test('parallel pipeline overlaps downloads with transcription and isolates cancellation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-parallel-'));
  process.env.WHISPER_DATA_DIR = path.join(root, 'data');
  process.env.WHISPER_OUTPUT_DIR = path.join(root, 'outputs');
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { TaskManager } = await import('../src/main/task-manager');
  t.mock.method(PythonWorkerClient.prototype, 'shutdown', async () => {});

  await t.test('downloads keep advancing while one warmed transcription slot is occupied', async (subtest) => {
    const manager = new TaskManager() as any;
    const preparations = new Map<string, ReturnType<typeof deferred>>();
    const transcriptionGate = deferred();
    let downloads = 0, peakDownloads = 0, transcriptions = 0, peakTranscriptions = 0;
    subtest.mock.method(PythonWorkerClient.prototype, 'run', async function (request: WorkerTaskRequest) {
      if (request.phase === 'prepare') {
        downloads++;
        peakDownloads = Math.max(peakDownloads, downloads);
        const gate = deferred(); preparations.set(request.taskId, gate);
        await gate.promise;
        downloads--;
      } else {
        transcriptions++;
        peakTranscriptions = Math.max(peakTranscriptions, transcriptions);
        await transcriptionGate.promise;
        transcriptions--;
      }
      return result(request);
    });
    const tasks = Array.from({ length: 4 }, (_, i) => manager.createTaskRecord(`https://youtu.be/${i}`, 'link'));
    manager.tasks.push(...tasks);
    const draining = manager.processQueue();
    await waitFor(() => preparations.size === 3);
    preparations.get(tasks[0].id)!.resolve();
    await waitFor(() => transcriptions === 1 && preparations.size === 4);
    assert.equal(downloads, 3);
    assert.equal(peakDownloads, 3);
    assert.equal(peakTranscriptions, 1);
    for (const gate of preparations.values()) gate.resolve();
    transcriptionGate.resolve();
    await draining;
    assert.ok(tasks.every((task) => task.status === 'completed'));
    assert.equal(peakTranscriptions, 1);
    assert.equal(manager.transcriptionWorkers.length, 1);
    assert.equal(manager.taskControllers.size, 0);
    await manager.shutdown();
  });

  await t.test('cancelling an active download does not cancel its peer or leak a permit', async (subtest) => {
    const manager = new TaskManager() as any;
    const started = new Set<string>();
    const gate = deferred();
    subtest.mock.method(PythonWorkerClient.prototype, 'run', async function (request: WorkerTaskRequest, _events: unknown, signal?: AbortSignal) {
      started.add(request.taskId);
      await Promise.race([
        gate.promise,
        new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
      ]);
      return result(request);
    });
    const tasks = Array.from({ length: 4 }, (_, i) => manager.createTaskRecord(`https://youtu.be/cancel${i}`, 'link', { downloadBehavior: 'downloadOnly' }));
    manager.tasks.push(...tasks);
    const draining = manager.processQueue();
    await waitFor(() => started.size === 3);
    assert.equal(await manager.cancelTask(tasks[0].id), true);
    await waitFor(() => started.size === 4);
    gate.resolve();
    await draining;
    assert.equal(tasks[0].status, 'cancelled');
    assert.ok(tasks.slice(1).every((task) => task.status === 'completed'));
    assert.equal(manager.taskControllers.size, 0);
    await manager.shutdown();
  });
});
