import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareModel, runProcess, withRuntimeLock } from '../scripts/model-runtime.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-model-runner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const model = path.join(root, 'weights.bin');
  await fs.writeFile(model, 'downloaded model fixture');
  const calls = [];
  const events = [];
  const request = { projectRoot: root, pythonPath: 'user-selected-python', engine: 'faster-whisper', model: 'tiny' };
  const options = {
    env: { WHISPER_DEVICE: 'cpu' }, platform: 'win32', onEvent: (event) => events.push(event),
    run: async (command, args, configuration) => {
      calls.push({ command, args, configuration });
      if (args.includes('model_download.py') || args.some((arg) => arg.endsWith('model_download.py'))) {
        configuration.onLine(JSON.stringify({ type: 'progress', message: '下载进度', downloadedBytes: 12, totalBytes: 24, percent: 50 }), 'stdout');
        configuration.onLine(JSON.stringify({ type: 'result', path: model }), 'stdout');
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: args.includes('import sys; print(sys.version_info.major)') ? '3\n' : '', stderr: '' };
    }
  };
  return { root, model, calls, events, request, options };
}

test('runtime prepares selected Python asynchronously, forwards real progress and reuses installed backend', async (t) => {
  const fixtureData = await fixture(t);
  const { request, options, calls, model, events } = fixtureData;
  const result = await prepareModel(request, options);
  assert.equal(result.path, model);
  assert.ok(calls.every((call) => call.command === 'user-selected-python'));
  assert.ok(!calls.some((call) => call.args.includes('pip')));
  const download = calls.find((call) => call.args.some((arg) => arg.endsWith('model_download.py')));
  assert.deepEqual(JSON.parse(download.configuration.input), { projectRoot: await fs.realpath(request.projectRoot), engine: 'faster-whisper', model: 'tiny' });
  assert.ok(events.some((event) => event.percent === 50 && event.downloadedBytes === 12 && event.totalBytes === 24));
});

test('missing engine installs only selected requirements; pip URLs cannot leak credentials into progress', async (t) => {
  const { request, options, calls, events } = await fixture(t);
  const originalRun = options.run;
  let installed = false;
  options.run = async (command, args, configuration) => {
    if (args.some((arg) => arg.includes('import faster_whisper')) && !installed) return { status: 1, stdout: '', stderr: 'missing module' };
    if (args.includes('pip') && args.includes('install')) {
      installed = true;
      calls.push({ command, args, configuration });
      configuration.onLine('Looking in indexes: https://user:secret@packages.example/simple?token=secret', 'stdout');
      return { status: 0, stdout: '', stderr: '' };
    }
    return originalRun(command, args, configuration);
  };
  await prepareModel(request, options);
  const install = calls.find((call) => call.args.includes('install'));
  assert.equal(install.command, request.pythonPath);
  assert.ok(install.args.some((arg) => arg.endsWith('requirements.txt')));
  assert.ok(!install.args.some((arg) => arg.endsWith('requirements-whisper.txt')));
  assert.ok(events.some((event) => event.message.includes('packages.example/simple')));
  assert.ok(events.every((event) => !event.message.includes('secret') && !event.message.includes('user:')));
});

test('native setup shares runtime lock and preserves existing model when downloader fails', async (t) => {
  const { request, options, model } = await fixture(t);
  request.engine = 'whisper.cpp';
  let ensured = 0;
  options.ensureWhisperCpp = async (root, environment) => {
    ensured += 1;
    assert.equal(root, await fs.realpath(request.projectRoot));
    assert.equal(environment.WHISPER_DEVICE, 'cpu');
  };
  const originalRun = options.run;
  options.run = async (command, args, configuration) => {
    if (args.some((arg) => arg.endsWith('model_download.py'))) {
      configuration.onLine(JSON.stringify({ type: 'error', code: 'MODEL_CHECKSUM_MISMATCH', message: 'checksum failed' }), 'stdout');
      return { status: 1, stdout: '', stderr: '' };
    }
    return originalRun(command, args, configuration);
  };
  await assert.rejects(prepareModel(request, options), { code: 'MODEL_CHECKSUM_MISMATCH' });
  assert.equal(ensured, 1);
  assert.equal(await fs.readFile(model, 'utf8'), 'downloaded model fixture');
});

test('native backend in a new custom Python installs missing common dependencies before runtime and model preparation', async (t) => {
  const { request, options, calls, model } = await fixture(t);
  request.engine = 'whisper.cpp';
  const originalRun = options.run;
  let commonReady = false;
  const order = [];
  options.run = async (command, args, configuration) => {
    if (args.some((argument) => argument.includes('import yt_dlp,requests,websocket'))) {
      order.push('common-probe');
      calls.push({ command, args, configuration });
      return { status: commonReady ? 0 : 1, stdout: '', stderr: commonReady ? '' : 'missing yt_dlp' };
    }
    if (args.includes('pip') && args.includes('install')) {
      order.push('common-install'); commonReady = true;
      calls.push({ command, args, configuration });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.some((argument) => argument.endsWith('model_download.py'))) order.push('model');
    return originalRun(command, args, configuration);
  };
  options.ensureWhisperCpp = async () => { assert.equal(commonReady, true); order.push('native'); };
  assert.equal((await prepareModel(request, options)).path, model);
  const install = calls.filter((call) => call.args.includes('pip') && call.args.includes('install'));
  assert.equal(install.length, 1);
  assert.equal(install[0].command, 'user-selected-python');
  assert.ok(install[0].args.some((argument) => argument.endsWith('requirements-common.txt')));
  assert.ok(!install[0].args.some((argument) => /requirements(?:-whisper|-faster-cuda)?\.txt$/.test(argument)));
  assert.deepEqual(order, ['common-probe', 'common-install', 'common-probe', 'native', 'model']);
  await prepareModel(request, options);
  assert.equal(calls.filter((call) => call.args.includes('pip') && call.args.includes('install')).length, 1);
});

test('invalid interpreter fails without silently using another environment', async (t) => {
  const { request, options } = await fixture(t);
  options.run = async () => ({ status: null, error: new Error('ENOENT'), stdout: '', stderr: '' });
  await assert.rejects(prepareModel(request, options), { code: 'MODEL_PYTHON_UNAVAILABLE' });
});

test('live environment lock serializes preparations and releases after errors', async (t) => {
  const { root } = await fixture(t);
  let active = 0;
  let peak = 0;
  const operation = () => withRuntimeLock(root, 'same-interpreter', async () => {
    active += 1;
    peak = Math.max(active, peak);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
  });
  await Promise.all([operation(), operation()]);
  assert.equal(peak, 1);
  await assert.rejects(withRuntimeLock(root, 'same-interpreter', async () => { throw new Error('failed fixture'); }), /failed fixture/);
  assert.equal((await fs.readdir(path.join(root, '.runtime', 'locks'))).length, 0);
});

test('child stdout protocol stays valid with Unicode and incomplete final line', async () => {
  const lines = [];
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write(JSON.stringify({type:'progress',message:'正在下载模型'})); process.stderr.write('diagnostic\\n')"], {
    onLine: (line, stream) => lines.push({ line, stream })
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(lines.find((entry) => entry.stream === 'stdout').line).message, '正在下载模型');
  assert.ok(lines.some((entry) => entry.stream === 'stderr' && entry.line === 'diagnostic'));
});
