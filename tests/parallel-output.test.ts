import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PythonWorkerClient } from '../src/main/python-worker';
import type { WorkerTaskRequest } from '../src/shared/types';

test('parallel tasks with identical titles retain separate output files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-output-collision-'));
  process.env.WHISPER_DATA_DIR = path.join(root, 'data');
  process.env.WHISPER_OUTPUT_DIR = path.join(root, 'outputs');
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { TaskManager } = await import('../src/main/task-manager');
  const manager = new TaskManager() as any;
  t.mock.method(PythonWorkerClient.prototype, 'shutdown', async () => {});
  t.mock.method(PythonWorkerClient.prototype, 'run', async (request: WorkerTaskRequest) => {
    const media = path.join(request.outputDir, 'fixture.txt');
    fs.writeFileSync(media, request.taskId);
    return { taskId: request.taskId, sourceType: request.sourceType, input: request.input,
      outputDir: request.outputDir, displayName: 'Identical title',
      transcriptText: '', transcriptSegments: [], outputFiles: { downloadedMedia: media } };
  });
  const tasks = Array.from({ length: 3 }, (_, i) => manager.createTaskRecord(`https://youtu.be/title${i}`, 'link', { downloadBehavior: 'downloadOnly' }));
  manager.tasks.push(...tasks);
  await manager.processQueue();
  assert.ok(tasks.every((task) => task.status === 'completed'));
  assert.equal(new Set(tasks.map((task) => task.outputDir)).size, 3);
  for (const task of tasks) assert.equal(fs.readFileSync(task.outputFiles.downloadedMedia, 'utf8'), task.id);
  await manager.shutdown();
});
