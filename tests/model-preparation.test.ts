import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelPreparationManager } from '../src/main/model-preparation';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settings = (model = 'tiny') => ({ pythonPath: 'selected-python', transcriptionEngine: 'whisper.cpp' as const, whisperModel: model });

test('model preparation deduplicates aliases and cancelling one waiter leaves the shared download running', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-model-manager-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelPath = path.join(root, 'model.bin');
  fs.writeFileSync(modelPath, 'fixture');
  const gate = deferred();
  let runs = 0;
  const manager = new ModelPreparationManager({ projectRoot: root, onChange: () => {}, run: async (request, progress, signal) => {
    runs++;
    assert.equal(request.model, 'large-v3-turbo');
    progress({ message: 'Downloading', percent: 25, downloadedBytes: 1, totalBytes: 4 });
    await gate.promise;
    assert.equal(signal.aborted, false);
    return { path: modelPath, pythonLibraryDirs: ['/selected-python/nvidia/cudnn/lib'] };
  } });
  const first = manager.prepare(settings('turbo'));
  assert.equal(manager.prepare(settings('large-v3-turbo')).state.id, first.state.id);
  const waiter = new AbortController();
  const abandoned = assert.rejects(manager.waitFor(settings('turbo'), waiter.signal), { code: 'model_preparation_cancelled' });
  const continuing = manager.waitFor(settings('turbo'));
  await tick();
  assert.equal(manager.getStates()[0].percent, 25);
  waiter.abort();
  await abandoned;
  gate.resolve();
  assert.equal(await continuing, modelPath);
  assert.equal(runs, 1);
  assert.equal(manager.getStates()[0].status, 'ready');
  assert.deepEqual(manager.getPythonLibraryDirs('selected-python'), ['/selected-python/nvidia/cudnn/lib']);
  assert.deepEqual(manager.getPythonLibraryDirs('other-python'), []);
  await manager.shutdown();
});

test('queued cancellation is immediate, failed jobs can retry, and dependency work is serialized', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-model-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelPath = path.join(root, 'model.bin');
  fs.writeFileSync(modelPath, 'fixture');
  const gate = deferred();
  let running = 0, peak = 0, failures = 0;
  const invoked: string[] = [];
  const manager = new ModelPreparationManager({ projectRoot: root, maxConcurrent: 1, onChange: () => {}, run: async (request) => {
    invoked.push(request.model);
    running++; peak = Math.max(peak, running);
    try {
      if (request.model === 'tiny') await gate.promise;
      if (request.model === 'small' && failures++ === 0) throw new Error('Network failure');
      return modelPath;
    } finally { running--; }
  } });
  const first = manager.prepare(settings());
  const queued = manager.prepare(settings('base'));
  const rejected = assert.rejects(queued.promise, { code: 'model_preparation_cancelled' });
  assert.equal(manager.cancel(queued.state.id), true);
  await rejected;
  assert.equal(manager.getStates().find((state) => state.model === 'base')?.status, 'cancelled');
  gate.resolve(); await first.promise;
  const failed = manager.prepare(settings('small'));
  await assert.rejects(failed.promise, /Network failure/);
  assert.equal(failed.state.status, 'failed');
  assert.equal(await manager.prepare(settings('small'), true).promise, modelPath);
  assert.equal(peak, 1);
  assert.ok(!invoked.includes('base'));
  await manager.shutdown();
});

test('default preparation slots let a newly selected model start beside a slow old download', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-model-parallel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelPath = path.join(root, 'model.bin'); fs.writeFileSync(modelPath, 'fixture');
  const oldDownload = deferred(), newDownload = deferred();
  const started: string[] = [];
  let running = 0, peak = 0;
  const manager = new ModelPreparationManager({ projectRoot: root, onChange: () => {}, run: async (request) => {
    started.push(request.model); running++; peak = Math.max(peak, running);
    try {
      if (request.model === 'large-v3-turbo') await oldDownload.promise;
      if (request.model === 'tiny') await newDownload.promise;
      return modelPath;
    } finally { running--; }
  } });
  const old = manager.prepare(settings('turbo'));
  const newlySelected = manager.prepare(settings('tiny'));
  const pending = manager.prepare(settings('base'));
  await tick();
  assert.deepEqual(started, ['large-v3-turbo', 'tiny']);
  assert.equal(pending.state.status, 'queued');
  newDownload.resolve(); await newlySelected.promise; await tick();
  assert.equal(old.state.status, 'preparing');
  assert.equal(await pending.promise, modelPath);
  assert.deepEqual(started, ['large-v3-turbo', 'tiny', 'base']);
  assert.equal(peak, 2);
  oldDownload.resolve(); await old.promise;
  await manager.shutdown();
});

test('partial removal of a ready model directory prepares the missing files again', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-model-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelPath = path.join(root, 'snapshot'); fs.mkdirSync(modelPath);
  let runs = 0;
  const manager = new ModelPreparationManager({ projectRoot: root, onChange: () => {}, run: async () => {
    runs++;
    fs.writeFileSync(path.join(modelPath, 'model.bin'), 'fixture weights');
    fs.writeFileSync(path.join(modelPath, 'config.json'), '{}');
    return modelPath;
  } });
  const first = manager.prepare(settings()); await first.promise;
  assert.equal(manager.prepare(settings()).state.id, first.state.id);
  fs.unlinkSync(path.join(modelPath, 'config.json'));
  const recovered = manager.prepare(settings());
  assert.notEqual(recovered.state.id, first.state.id);
  await recovered.promise;
  assert.equal(runs, 2);
  assert.ok(fs.statSync(path.join(modelPath, 'config.json')).size > 0);
  await manager.shutdown();
});

test('shutdown rejects queued jobs and waits for running process cleanup despite failing observers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-model-shutdown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelPath = path.join(root, 'model.bin'); fs.writeFileSync(modelPath, 'fixture');
  const processClosed = deferred();
  const invoked: string[] = [];
  let observedAbort = false;
  const manager = new ModelPreparationManager({ projectRoot: root, maxConcurrent: 1,
    onChange: () => { throw new Error('observer failed'); },
    run: async (request, progress, signal) => {
      invoked.push(request.model); progress({ message: 'Downloading' });
      signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
      await processClosed.promise;
      return modelPath;
    }
  });
  const active = manager.prepare(settings());
  const captured = settings('base');
  const queued = manager.prepare(captured);
  captured.pythonPath = 'edited-after-enqueue';
  await tick();
  const activeRejection = assert.rejects(active.promise, { code: 'model_preparation_cancelled' });
  const queuedRejection = assert.rejects(queued.promise, { code: 'model_preparation_cancelled' });
  let shutdownCompleted = false;
  const closing = manager.shutdown().then(() => { shutdownCompleted = true; });
  await Promise.all([activeRejection, queuedRejection]); await tick();
  assert.equal(observedAbort, true);
  assert.equal(shutdownCompleted, false);
  assert.deepEqual(invoked, ['tiny']);
  processClosed.resolve(); await closing;
  assert.equal(shutdownCompleted, true);
});

test('pending model preparations retain the settings snapshot when the caller mutates it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-model-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelPath = path.join(root, 'model.bin'); fs.writeFileSync(modelPath, 'fixture');
  const firstDownload = deferred();
  const requests: Array<{ pythonPath: string; model: string }> = [];
  const manager = new ModelPreparationManager({ projectRoot: root, maxConcurrent: 1, onChange: () => {}, run: async (request) => {
    requests.push(request);
    if (request.model === 'tiny') await firstDownload.promise;
    return modelPath;
  } });
  const first = manager.prepare(settings());
  const selected = settings('base');
  const queued = manager.prepare(selected);
  selected.pythonPath = 'new-python'; selected.whisperModel = 'small';
  firstDownload.resolve(); await Promise.all([first.promise, queued.promise]);
  assert.deepEqual(requests.map((request) => [request.pythonPath, request.model]), [['selected-python', 'tiny'], ['selected-python', 'base']]);
  await manager.shutdown();
});

test('task keeps its selected interpreter and model while settings change and waits before taking a transcription slot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-model-task-'));
  const oldData = process.env.WHISPER_DATA_DIR, oldOutput = process.env.WHISPER_OUTPUT_DIR;
  process.env.WHISPER_DATA_DIR = path.join(root, 'data');
  process.env.WHISPER_OUTPUT_DIR = path.join(root, 'outputs');
  t.after(() => {
    if (oldData === undefined) delete process.env.WHISPER_DATA_DIR; else process.env.WHISPER_DATA_DIR = oldData;
    if (oldOutput === undefined) delete process.env.WHISPER_OUTPUT_DIR; else process.env.WHISPER_OUTPUT_DIR = oldOutput;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { TaskManager } = await import('../src/main/task-manager');
  const { PythonWorkerClient } = await import('../src/main/python-worker');
  const manager = new TaskManager() as any;
  const modelGate = deferred(), mediaGate = deferred();
  const modelPath = path.join(root, 'model.bin'); fs.writeFileSync(modelPath, 'fixture');
  const preparation = new ModelPreparationManager({ projectRoot: root, onChange: () => {}, run: async (request) => {
    assert.equal(request.pythonPath, 'original-python');
    assert.equal(request.model, 'tiny');
    await modelGate.promise; return modelPath;
  } });
  manager.modelPreparation = preparation;
  manager.settings = { ...manager.settings, pythonPath: 'original-python', transcriptionEngine: 'whisper.cpp', whisperModel: 'tiny' };
  const phases: string[] = [];
  const paths: string[] = [];
  t.mock.method(PythonWorkerClient.prototype, 'shutdown', async () => {});
  t.mock.method(PythonWorkerClient.prototype, 'run', async function (this: any, request: any) {
    phases.push(request.phase); paths.push(this.defaultOptions.pythonPath);
    assert.equal(request.whisperModel, 'tiny');
    if (request.phase === 'prepare') await mediaGate.promise;
    return { taskId: request.taskId, sourceType: request.sourceType, input: request.input, displayName: 'fixture', outputDir: request.outputDir,
      transcriptText: 'fixture', transcriptSegments: [], outputFiles: {}, preparedMedia: { transcriptInputPath: 'fixture.wav', mediaInfo: {} } };
  });
  const task = manager.createTaskRecord('fixture.wav', 'file'); manager.tasks.push(task);
  const execution = manager.executeTask(task);
  while (!phases.length) await tick();
  manager.settings = { ...manager.settings, pythonPath: 'new-python', whisperModel: 'small' };
  mediaGate.resolve(); await tick();
  assert.deepEqual(phases, ['prepare']);
  assert.equal(manager.transcriptionWorkers.length, 0);
  assert.match(task.progressMessage, /tiny.*模型/);
  modelGate.resolve(); await execution;
  assert.deepEqual(phases, ['prepare', 'transcribe']);
  assert.deepEqual(paths, ['original-python', 'original-python']);
  assert.equal(task.status, 'completed');
  await manager.shutdown();
});
