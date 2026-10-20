import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TaskRecord } from '../src/shared/types';

const fixture = (id: string, outputDir?: string): TaskRecord => ({
  id, sourceType: 'link', input: 'https://example.invalid/media', displayName: id, status: 'completed',
  progressPercent: 100, progressMessage: '已完成', createdAt: '2026-10-20T01:00:00.000Z',
  updatedAt: '2026-10-20T01:01:00.000Z', attempts: 1, translateToChinese: false,
  downloadBehavior: 'transcribe', videoQuality: 'best', transcriptionLanguage: 'auto',
  transcriptText: 'Preserved full result until deletion.', outputDir, outputFiles: {}, logs: []
});

test('task deletion removes one complete task and respects storage ownership', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-task-deletion-'));
  const previous = { data: process.env.WHISPER_DATA_DIR, output: process.env.WHISPER_OUTPUT_DIR };
  process.env.WHISPER_DATA_DIR = path.join(root, 'data');
  process.env.WHISPER_OUTPUT_DIR = path.join(root, 'outputs');
  const outputRoot = process.env.WHISPER_OUTPUT_DIR;
  fs.mkdirSync(outputRoot, { recursive: true });
  t.after(() => {
    if (previous.data === undefined) delete process.env.WHISPER_DATA_DIR;
    else process.env.WHISPER_DATA_DIR = previous.data;
    if (previous.output === undefined) delete process.env.WHISPER_OUTPUT_DIR;
    else process.env.WHISPER_OUTPUT_DIR = previous.output;
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { TaskManager } = await import('../src/main/task-manager');
  const storage = await import('../src/main/task-results');
  const store = await import('../src/main/store');
  const managerFor = (...tasks: TaskRecord[]): any => {
    store.saveHistoryRecords([]);
    const manager = new TaskManager() as any;
    for (const task of tasks) {
      manager.tasks.push(task);
      if (!['queued', 'downloading', 'preprocessing', 'transcribing', 'translating'].includes(task.status)) manager.finalizeHistory(task);
    }
    return manager;
  };
  const directory = (name: string): string => {
    const target = path.join(outputRoot, name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'result.txt'), 'opaque text fixture');
    return target;
  };

  await t.test('deletes queue, history, cache, and outputs together; restart and repeat cannot revive it', async () => {
    const task = fixture('complete', directory('complete'));
    const other = fixture('other', directory('other'));
    const original = path.join(root, 'original.wav');
    fs.writeFileSync(original, 'opaque original');
    task.sourceType = 'file'; task.input = original;
    const manager = managerFor(task, other);
    assert.equal(await manager.deleteTaskDirectory(task.id), true);
    assert.deepEqual(manager.getSnapshot().tasks.map((item: TaskRecord) => item.id), [other.id]);
    assert.deepEqual(manager.getSnapshot().history.map((item: TaskRecord) => item.id), [other.id]);
    assert.equal(storage.readTaskResult(task.id), undefined);
    assert.equal(fs.existsSync(task.outputDir!), false);
    assert.equal(manager.getHistoryResult(task.id), undefined);
    assert.equal(manager.getTaskFilePath(task.id, 'transcriptTxt'), undefined);
    const restarted = new TaskManager();
    assert.equal(restarted.getHistoryResult(task.id), undefined);
    assert.equal(await restarted.deleteTask(task.id), false);
    assert.ok(fs.existsSync(original));
    assert.ok(fs.existsSync(other.outputDir!));
  });

  await t.test('missing folders, absent output paths, and history-only records can still be deleted', async () => {
    const missing = fixture('missing-output', path.join(root, 'old-missing-root', 'result'));
    const noOutput = { ...fixture('no-output'), status: 'cancelled' } as TaskRecord;
    const manager = managerFor(missing, noOutput);
    manager.tasks.splice(0, 1);
    assert.equal(await manager.deleteTask(missing.id), true);
    assert.equal(await manager.deleteTask(noOutput.id), true);
    assert.deepEqual(manager.getSnapshot().tasks, []);
    assert.deepEqual(store.getHistoryRecords(), []);
    assert.equal(storage.readTaskResult(missing.id), undefined);
    assert.equal(storage.readTaskResult(noOutput.id), undefined);
  });

  await t.test('a failed retry deletes both its current folder and the archived previous folder', async () => {
    const task = fixture('retry-folders', directory('retry-old'));
    const previousDirectory = task.outputDir!;
    const manager = managerFor(task);
    task.outputDir = directory('retry-new'); task.status = 'failed';
    assert.equal(await manager.deleteTask(task.id), true);
    assert.equal(fs.existsSync(previousDirectory), false);
    assert.equal(fs.existsSync(task.outputDir!), false);
  });

  await t.test('queued, worker-active, and settling tasks refuse deletion, including history requests during retry', async () => {
    for (const status of ['queued', 'downloading', 'preprocessing', 'transcribing', 'translating'] as const) {
      const task = fixture(`active-${status}`);
      const manager = managerFor(task);
      task.status = status;
      assert.equal(await manager.deleteTask(task.id), false);
      assert.ok(storage.readTaskResult(task.id));
      assert.equal(manager.getSnapshot().history.length, 1);
    }
    for (const state of ['taskControllers', 'runningTasks']) {
      const task = fixture(`active-${state}`);
      const manager = managerFor(task);
      manager[state].set(task.id, state === 'taskControllers' ? new AbortController() : Promise.resolve());
      assert.equal(await manager.deleteTask(task.id), false);
      assert.equal(manager.getSnapshot().tasks.length, 1);
    }
  });

  await t.test('a pending deletion blocks retry and a second deletion', async (subtest) => {
    const task = { ...fixture('deletion-race', directory('deletion-race')), status: 'failed' } as TaskRecord;
    const manager = managerFor(task);
    let release!: () => void, signalStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const validate = manager.validateDeletionDirectory.bind(manager);
    subtest.mock.method(manager, 'validateDeletionDirectory', async (...args: unknown[]) => {
      signalStarted(); await gate; return validate(...args);
    });
    const deletion = manager.deleteTask(task.id);
    await started;
    assert.equal(await manager.retryTask(task.id), false);
    assert.equal(await manager.deleteTask(task.id), false);
    release();
    assert.equal(await deletion, true);
    assert.equal(manager.getSnapshot().tasks.length, 0);
  });

  await t.test('a filesystem failure is reported and keeps queue, history, and cached result', async (subtest) => {
    const task = fixture('rm-failure', directory('rm-failure'));
    const manager = managerFor(task);
    const remove = fsPromises.rm.bind(fsPromises);
    subtest.mock.method(fsPromises, 'rm', async (filename: fs.PathLike, options?: fs.RmOptions) => {
      if (String(filename) === task.outputDir) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
      return remove(filename, options);
    });
    await assert.rejects(manager.deleteTask(task.id), /fixture permission denied/);
    assert.equal(manager.getSnapshot().tasks.length, 1);
    assert.equal(manager.getSnapshot().history.length, 1);
    assert.ok(storage.readTaskResult(task.id));
    assert.ok(fs.existsSync(task.outputDir!));
  });

  await t.test('root, another output root, shared folders, nested references, and original files are protected', async () => {
    const outside = path.join(root, 'old-output-root', 'result');
    fs.mkdirSync(outside, { recursive: true });
    const scenarios = [outputRoot, path.parse(outputRoot).root, outside];
    for (const [index, target] of scenarios.entries()) {
      const task = fixture(`unsafe-${index}`, target);
      const manager = managerFor(task);
      await assert.rejects(manager.deleteTask(task.id), /输出/);
      assert.ok(storage.readTaskResult(task.id));
      assert.ok(fs.existsSync(target));
    }
    const shared = directory('shared');
    for (const otherDirectory of [shared, path.join(shared, 'nested')]) {
      fs.mkdirSync(otherDirectory, { recursive: true });
      const task = fixture('shared-owner', shared);
      const manager = managerFor(task, fixture('shared-reference', otherDirectory));
      await assert.rejects(manager.deleteTask(task.id), /引用/);
      assert.ok(fs.existsSync(shared));
    }
    const task = fixture('original-in-output', directory('original-in-output'));
    task.sourceType = 'file'; task.input = path.join(task.outputDir!, 'result.txt');
    await assert.rejects(managerFor(task).deleteTask(task.id), /原始文件/);
    assert.ok(fs.existsSync(task.input));
  });

  await t.test('output junctions cannot lead deletion outside the managed root', async () => {
    const outside = path.join(root, 'junction-target');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const linked = path.join(outputRoot, 'junction');
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const task = fixture('junction', linked);
    await assert.rejects(managerFor(task).deleteTask(task.id), /普通目录|符号链接/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
    fs.unlinkSync(linked);
  });

  await t.test('managed uploads are removed only after their final reference is gone', async () => {
    const uploads = path.join(root, 'data', 'uploads'); fs.mkdirSync(uploads, { recursive: true });
    const upload = path.join(uploads, 'shared.wav'); fs.writeFileSync(upload, 'opaque upload');
    const first = { ...fixture('upload-first'), sourceType: 'file', input: upload } as TaskRecord;
    const second = { ...fixture('upload-second'), sourceType: 'file', input: upload } as TaskRecord;
    const manager = managerFor(first, second);
    assert.equal(await manager.deleteTask(first.id), true);
    assert.ok(fs.existsSync(upload));
    // Its remaining owner survives only in history, as it would after a restart.
    manager.tasks.splice(0, 1);
    assert.equal(await manager.deleteTask(second.id), true);
    assert.equal(fs.existsSync(upload), false);

    const legacyUpload = path.join(uploads, 'legacy.wav'); fs.writeFileSync(legacyUpload, 'opaque legacy upload');
    const legacy = { ...fixture('legacy-upload', directory('legacy-upload')), sourceType: 'file', input: legacyUpload } as TaskRecord;
    const historyOnly = managerFor(legacy);
    historyOnly.tasks.splice(0, 1);
    delete historyOnly.history[0].input;
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(legacyUpload, old, old);
    await historyOnly.cleanupStorage();
    assert.ok(fs.existsSync(legacyUpload));
    await historyOnly.clearHistory();
    assert.equal(fs.existsSync(legacyUpload), false);
    assert.equal(storage.readTaskResult(legacy.id), undefined);
    assert.ok(fs.existsSync(legacy.outputDir!));
  });

  await t.test('startup cleanup preserves referenced working outputs and removes only an aged abandoned directory', async () => {
    const retained = directory('__working__-retained-a1');
    const abandoned = directory('__working__-abandoned-a1');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(retained, old, old); fs.utimesSync(abandoned, old, old);
    const manager = managerFor({ ...fixture('retained', retained), status: 'failed' });
    manager.tasks.splice(0, 1);
    await manager.cleanupStorage();
    assert.ok(fs.existsSync(retained));
    assert.equal(fs.existsSync(abandoned), false);
  });
});
