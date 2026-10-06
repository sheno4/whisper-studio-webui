import assert from 'node:assert/strict';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { PythonWorkerClient } from '../src/main/python-worker';
import type { WorkerEvent, WorkerResultPayload, WorkerTaskRequest } from '../src/shared/types';

const options = { pythonPath: 'python-fixture', workerScriptPath: 'worker-fixture.py', env: {} };

const request = (taskId: string): WorkerTaskRequest => ({
  taskId, sourceType: 'file', input: 'fixture.wav', displayName: 'fixture', outputDir: 'outputs',
  whisperModel: 'tiny', transcriptionEngine: 'faster-whisper', keepAudio: false,
  logLevel: 'info', downloadBehavior: 'transcribe', videoQuality: 'best', projectRoot: '.'
});

const result = (taskId: string): WorkerResultPayload => ({
  taskId, sourceType: 'file', input: 'fixture.wav', displayName: '中文😀', outputDir: 'outputs',
  transcriptText: '你好，世界😀', transcriptSegments: [], outputFiles: {}
});

const fakeChild = (): ChildProcessWithoutNullStreams => Object.assign(new EventEmitter(), {
  stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
  exitCode: null, signalCode: null, pid: undefined
}) as ChildProcessWithoutNullStreams;

const complete = (child: ChildProcessWithoutNullStreams, taskId: string): void => {
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', data: result(taskId) }) + '\n'));
};

test('a hot worker preserves split UTF-8 and rejects overlapping requests', async (t) => {
  const children: ChildProcessWithoutNullStreams[] = [];
  t.mock.method(childProcess, 'spawn', () => {
    const child = fakeChild(); children.push(child); return child;
  });
  const client = new PythonWorkerClient(options);
  t.after(() => client.shutdown());
  const events: WorkerEvent[] = [];
  const first = client.run(request('first'), (event) => events.push(event));
  await assert.rejects(client.run(request('overlap'), () => undefined), { code: 'worker_busy' });
  const wire = Buffer.from(JSON.stringify({ type: 'result', data: result('first') }) + '\n');
  const split = wire.indexOf(Buffer.from('中')) + 1;
  children[0].stdout.emit('data', wire.subarray(0, split));
  children[0].stdout.emit('data', wire.subarray(split));
  assert.deepEqual(await first, result('first'));
  assert.equal(client.isBusy, false);

  const second = client.run(request('second'), (event) => events.push(event));
  const stderr = Buffer.from('警告😀\n');
  children[0].stderr.emit('data', stderr.subarray(0, 1));
  children[0].stderr.emit('data', stderr.subarray(1));
  complete(children[0], 'second');
  await second;
  assert.equal(children.length, 1, 'sequential GPU jobs reuse the loaded process');
  assert.ok(events.some((event) => event.type === 'log' && event.message === '警告😀' && event.context === 'stderr'));
});

test('cancelling one parallel worker leaves another client and its replacement intact', async (t) => {
  const children: ChildProcessWithoutNullStreams[] = [];
  t.mock.method(childProcess, 'spawn', () => {
    const child = fakeChild(); children.push(child); return child;
  });
  const firstClient = new PythonWorkerClient(options);
  const secondClient = new PythonWorkerClient(options);
  t.after(() => Promise.all([firstClient.shutdown(), secondClient.shutdown()]));
  const controller = new AbortController();
  const cancelled = firstClient.run(request('cancelled'), () => undefined, controller.signal);
  const cancellation = assert.rejects(cancelled, { name: 'CancelledTaskError', code: 'task_cancelled' });
  const independent = secondClient.run(request('independent'), () => undefined);
  controller.abort();
  await cancellation;
  assert.equal(secondClient.isBusy, true);
  const replacement = firstClient.run(request('replacement'), () => undefined);

  children[0].emit('close', 1);
  children[0].emit('error', new Error('late failure'));
  children[0].stdout.emit('data', Buffer.from('{"type":"error","code":"late","message":"old failure"}\n'));
  assert.equal(firstClient.isBusy, true);
  assert.equal(secondClient.isBusy, true);
  complete(children[1], 'independent');
  complete(children[2], 'replacement');
  assert.deepEqual(await independent, result('independent'));
  assert.deepEqual(await replacement, result('replacement'));
});

test('an interpreter change replaces the hot process without accepting its late output', async (t) => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const commands: string[] = [];
  t.mock.method(childProcess, 'spawn', (command: string) => {
    const child = fakeChild(); children.push(child); commands.push(command); return child;
  });
  const client = new PythonWorkerClient(options);
  t.after(() => client.shutdown());
  const first = client.run(request('first'), () => undefined);
  complete(children[0], 'first');
  await first;
  const next = client.run(request('changed'), () => undefined, undefined, { ...options, pythonPath: 'new-python' });
  await new Promise((resolve) => setImmediate(resolve));
  children[0].emit('close', 0);
  complete(children[0], 'first');
  assert.deepEqual(commands, ['python-fixture', 'new-python']);
  assert.equal(client.isBusy, true);
  complete(children[1], 'changed');
  await next;
});

test('a timeout invalidates only its worker and a structured failure keeps its code', async (t) => {
  const children: ChildProcessWithoutNullStreams[] = [];
  t.mock.method(childProcess, 'spawn', () => {
    const child = fakeChild(); children.push(child); return child;
  });
  const client = new PythonWorkerClient({ ...options, timeoutMs: 10 });
  t.after(() => client.shutdown());
  await assert.rejects(client.run(request('timeout'), () => undefined), { code: 'worker_timeout' });
  const next = client.run(request('failure'), () => undefined, undefined, options);
  const failure = assert.rejects(next, { code: 'auth_required', message: 'Sign in required' });
  children[1].stdout.emit('data', Buffer.from('{"type":"error","code":"auth_required","message":"Sign in required"}\n'));
  await failure;
  assert.equal(client.isBusy, false);
});

test('shutdown rejects its active job and prevents another worker from starting', async (t) => {
  let spawned = 0;
  t.mock.method(childProcess, 'spawn', () => { spawned++; return fakeChild(); });
  const client = new PythonWorkerClient(options);
  const running = client.run(request('shutdown'), () => undefined);
  const rejected = assert.rejects(running, { code: 'worker_shutdown' });
  await client.shutdown();
  await rejected;
  await assert.rejects(client.run(request('after-shutdown'), () => undefined), { code: 'worker_shutdown' });
  assert.equal(spawned, 1);
});

test('UTF-8 result framing preserves every possible split boundary in the hot worker', async (t) => {
  const child = fakeChild();
  let spawned = 0;
  t.mock.method(childProcess, 'spawn', () => { spawned++; return child; });
  const client = new PythonWorkerClient(options);
  t.after(() => client.shutdown());
  const expected = result('utf8-boundary');
  const wire = Buffer.from(JSON.stringify({ type: 'result', data: expected }) + '\r\n');
  // Each split exercises a different framing or multibyte decoder boundary.
  for (let split = 1; split < wire.length; split++) {
    const pending = client.run(request('utf8-boundary'), () => undefined);
    child.stdout.emit('data', wire.subarray(0, split));
    child.stdout.emit('data', wire.subarray(split));
    assert.deepEqual(await pending, expected, `wire split at byte ${split}`);
  }
  assert.equal(spawned, 1, 'all framed requests share the same hot process');
});

test('a mismatched taskId fails the request and starts a clean replacement worker', async (t) => {
  const children: ChildProcessWithoutNullStreams[] = [];
  t.mock.method(childProcess, 'spawn', () => {
    const child = fakeChild(); children.push(child); return child;
  });
  const client = new PythonWorkerClient(options);
  t.after(() => client.shutdown());
  const incorrect = client.run(request('expected'), () => undefined);
  const failure = assert.rejects(incorrect, { code: 'worker_protocol' });
  complete(children[0], 'another-task');
  await failure;
  assert.equal(client.isBusy, false);
  const recovered = client.run(request('recovered'), () => undefined);
  assert.equal(children.length, 2);
  complete(children[0], 'expected');
  complete(children[1], 'recovered');
  assert.deepEqual(await recovered, result('recovered'));
});
