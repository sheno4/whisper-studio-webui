import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('queue failures stay contained and worker text stays intact', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-queue-recovery-'));
  process.env.WHISPER_DATA_DIR = path.join(root, 'data');
  process.env.WHISPER_OUTPUT_DIR = path.join(root, 'outputs');
  const { TaskManager } = await import('../src/main/task-manager');
  const store = await import('../src/main/store');

  await t.test('download preparation starts at zero instead of ninety percent', () => {
    const manager = new TaskManager() as any;
    const task = manager.createTaskRecord('https://youtu.be/abcdefghijk', 'link', { downloadBehavior: 'downloadOnly' });
    task.downloadBehavior = 'downloadOnly';
    task.progressPercent = 0;
    assert.equal(manager.mapWorkerProgress(task, 'preprocessing', 0), 0);
    assert.equal(manager.mapWorkerProgress(task, 'downloading', 50), 45);
    task.progressPercent = 90;
    assert.equal(manager.mapWorkerProgress(task, 'preprocessing', 50), 94.5);
  });

  await t.test('upload storage prefixes are hidden without changing external filenames', () => {
    const manager = new TaskManager() as any;
    const filename = '12345678-1234-1234-1234-123456789abc-审查音频.wav';
    const uploaded = manager.createTaskRecord(path.join(root, 'data', 'uploads', filename), 'file');
    const external = manager.createTaskRecord(path.join(root, filename), 'file');
    assert.equal(uploaded.displayName, '审查音频');
    assert.equal(external.displayName, path.parse(filename).name);
  });

  await t.test('rejected settings leave both persisted and active settings unchanged', async () => {
    delete process.env.WHISPER_OUTPUT_DIR;
    store.saveSettingsView({ ...store.getSettingsView(), outputDir: path.join(root, 'outputs') });
    const manager = new TaskManager();
    const beforeActive = structuredClone(manager.getSettings());
    const settingsFile = path.join(root, 'data', 'settings.json');
    const beforeDisk = fs.readFileSync(settingsFile, 'utf8');
    const invalidOutput = path.join(root, 'ordinary-file');
    fs.writeFileSync(invalidOutput, 'fixture');
    await assert.rejects(manager.saveSettings({ ...beforeActive, outputDir: invalidOutput, whisperModel: 'changed-model' }));
    assert.deepEqual(manager.getSettings(), beforeActive);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), beforeDisk);
  });

  await t.test('an output mkdir error fails one task and the next queued task completes', async () => {
    const manager = new TaskManager() as any;
    const blocker = path.join(root, 'blocked-output');
    fs.writeFileSync(blocker, 'fixture');
    const first = manager.createTaskRecord('first.wav', 'file');
    const second = manager.createTaskRecord('second.wav', 'file');
    const normalBuild = manager.buildOutputDir.bind(manager);
    manager.buildOutputDir = (task: any) => task.id === first.id ? path.join(blocker, 'child') : normalBuild(task);
    let workerCalls = 0;
    manager.runWorkerTask = async (_task: any, request: any) => {
      workerCalls++;
      return { outputDir: request.outputDir, displayName: 'next-task', outputFiles: {}, transcriptText: 'done', transcriptSegments: [] };
    };
    manager.tasks.push(first, second);
    await manager.processQueue();
    assert.equal(first.status, 'failed');
    assert.match(first.error, /ENOTDIR|EEXIST/);
    assert.equal(second.status, 'completed');
    assert.equal(workerCalls, 1);
    assert.equal(manager.isProcessing, false);
    assert.equal(manager.taskControllers.size, 0);
    assert.equal(manager.runningTasks.size, 0);
  });

  await t.test('unwritable log storage does not reject queue execution', async (subtest) => {
    const promises = await import('node:fs/promises');
    const manager = new TaskManager() as any;
    const task = manager.createTaskRecord('log-test.wav', 'file');
    manager.tasks.push(task);
    subtest.mock.method(promises.default, 'appendFile', async () => { throw new Error('synthetic log I/O failure'); });
    const errors: unknown[][] = [];
    subtest.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    manager.appendTaskLog(task.id, 'info', 'test log');
    const until = Date.now() + 1000;
    while (errors.length === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(errors.length, 1);
    assert.equal(task.logs[0].message, 'test log');
  });
});
