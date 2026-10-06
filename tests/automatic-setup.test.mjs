import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupProject, setupOptions } from '../scripts/setup.mjs';
import { prepareLaunch } from '../scripts/launch.mjs';
import { chooseBackend, chooseModel } from '../scripts/hardware.mjs';
import { getVenvPython } from '../scripts/python-runtime.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-auto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['requirements-common.txt', 'requirements.txt', 'requirements-whisper.txt', 'requirements-faster-cuda.txt']) fs.writeFileSync(path.join(root, file), file);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'source-v1');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  const calls = [];
  let pythonReady = false;
  const options = {
    env: {}, hardware: { platform: 'win32', arch: 'x64', memoryGB: 16, gpus: [] },
    canRunPython: () => pythonReady,
    ensurePythonRuntime: async () => { calls.push('python'); return { command: 'managed-python', args: [] }; },
    ensureFfmpeg: async () => { calls.push('ffmpeg'); return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', binDir: null }; },
    ensureChromiumBrowser: async () => { calls.push('browser'); return null; },
    run: (_command, args) => {
      if (args.includes('venv')) pythonReady = true;
      if (args.includes('pip') && args.includes('install')) calls.push(`pip:${args.join(' ')}`);
      return { status: 0, stdout: '', stderr: '' };
    },
    prefetchModel: async (_root, _python, engine, model) => {
      calls.push(`model:${engine}:${model}`);
      const file = path.join(root, 'downloaded-model.bin');
      fs.writeFileSync(file, 'model'); return file;
    }
  };
  return { root, options, calls, pythonReady: () => { pythonReady = true; } };
}

test('new setup initializes selected backend/model; repeat skips installs and model, requirement changes repair', async (t) => {
  const { root, options, calls } = fixture(t);
  const configuration = await setupProject(root, options);
  assert.equal(configuration.engine, 'faster-whisper');
  assert.equal(configuration.model, 'small');
  assert.equal(configuration.pythonPath, getVenvPython(root));
  const first = calls.filter((call) => /^(pip:|model:|python$)/.test(call));
  assert.ok(first.length >= 4);
  await setupProject(root, options);
  assert.deepEqual(calls.filter((call) => /^(pip:|model:|python$)/.test(call)), first);
  fs.appendFileSync(path.join(root, 'requirements.txt'), '\nchanged');
  await setupProject(root, options);
  assert.equal(calls.filter((call) => call.startsWith('model:')).length, 1);
  assert.equal(calls.filter((call) => call.includes('requirements.txt')).length, 2);
});

test('existing settings, history and encrypted keys survive an explicit backend change', async (t) => {
  const { root, options, pythonReady } = fixture(t);
  pythonReady();
  fs.mkdirSync(path.join(root, '.data'));
  const document = { settings: { pythonPath: getVenvPython(root), transcriptionEngine: 'whisper', whisperModel: 'base', outputDir: 'custom', translationServices: [{ id: 'saved' }] }, history: [{ id: 'completed' }], encryptedApiKeys: { saved: 'ciphertext' } };
  fs.writeFileSync(path.join(root, '.data', 'settings.json'), JSON.stringify(document));
  await setupProject(root, { ...options, backend: 'whisper.cpp', ensureWhisperCpp: async () => ({ executable: 'native-cli', variant: 'vulkan' }) });
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.data', 'settings.json'), 'utf8'));
  assert.deepEqual(saved.history, document.history);
  assert.deepEqual(saved.encryptedApiKeys, document.encryptedApiKeys);
  assert.equal(saved.settings.outputDir, 'custom');
  assert.deepEqual(saved.settings.translationServices, document.settings.translationServices);
  assert.equal(saved.settings.transcriptionEngine, 'whisper.cpp');
});

test('invalid explicit Python fails clearly; automatic browser failure leaves core usable', async (t) => {
  const { root, options } = fixture(t);
  await assert.rejects(setupProject(root, { ...options, env: { WHISPER_PYTHON_PATH: 'invalid-python' } }), /configured WHISPER_PYTHON_PATH/);
  const configuration = await setupProject(root, { ...options, ensureChromiumBrowser: async () => { throw new Error('missing browser shared library'); } });
  assert.equal(configuration.browserPath, null);
  assert.equal(configuration.engine, 'faster-whisper');
});

test('launch repairs partial npm install and rebuilds changed source while reusing a valid build', async (t) => {
  const { root } = fixture(t);
  const calls = [];
  let ready = false;
  const options = { skipSetup: true, env: {}, nodeDependenciesReady: () => ready, runNpm: (args) => {
    calls.push(args[0]);
    if (args[0] === 'ci') { ready = true; assert.ok(args.includes('--include=dev')); }
    if (args[0] === 'run') {
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(root, 'dist-server', 'server'), { recursive: true });
      fs.writeFileSync(path.join(root, 'dist', 'index.html'), 'built');
      fs.writeFileSync(path.join(root, 'dist-server', 'server', 'index.js'), 'built');
    }
  } };
  await prepareLaunch(root, options);
  await prepareLaunch(root, options);
  assert.deepEqual(calls, ['ci', 'run']);
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'source-v2');
  await prepareLaunch(root, options);
  assert.deepEqual(calls, ['ci', 'run', 'run']);
  ready = false;
  await prepareLaunch(root, options);
  assert.deepEqual(calls, ['ci', 'run', 'run', 'ci']);
});

test('hardware matrix chooses CUDA-capable backend, Vulkan and conservative models', () => {
  const hardware = (platform, arch, vendor, memoryMB = 8192) => ({ platform, arch, memoryGB: 32, gpus: vendor ? [{ vendor, memoryMB }] : [] });
  assert.equal(chooseBackend(hardware('win32', 'x64', 'nvidia')), 'faster-whisper');
  assert.equal(chooseBackend(hardware('linux', 'x64', 'amd')), 'whisper.cpp');
  assert.equal(chooseBackend(hardware('win32', 'x64', 'intel')), 'whisper.cpp');
  assert.equal(chooseBackend(hardware('win32', 'arm64', null), { cpu: true }), 'whisper.cpp');
  assert.equal(chooseBackend(hardware('linux', 'arm64', null)), 'faster-whisper');
  assert.equal(chooseBackend(hardware('linux', 'x64', 'amd'), { cpu: true }), 'faster-whisper');
  assert.equal(chooseModel(hardware('win32', 'x64', 'intel', 1024)), 'small');
  assert.equal(chooseModel(hardware('linux', 'x64', 'nvidia')), 'turbo');
  assert.deepEqual(setupOptions(['--cpu', '--backend=whisper.cpp', '--model', 'tiny']).backend, 'whisper.cpp');
  assert.throws(() => setupOptions(['--backend=invalid']), /Choose/);
});

test('CPU environment override and PATH interpreter survive setup without CUDA or UI overrides', async (t) => {
  const { root, options, calls } = fixture(t);
  const env = { WHISPER_DEVICE: ' CPU ', WHISPER_PYTHON_PATH: 'selected-python' };
  let seen;
  const configuration = await setupProject(root, {
    ...options, env,
    hardware: { platform: 'linux', arch: 'x64', memoryGB: 32, gpus: [{ vendor: 'nvidia', memoryMB: 16000 }] },
    canRunPython: (command) => { seen = command; return true; }
  });
  assert.equal(seen, 'selected-python');
  assert.equal(configuration.pythonPath, 'selected-python');
  assert.equal(configuration.model, 'small');
  assert.equal(configuration.accelerator, 'cpu');
  assert.equal(configuration.cpu, true);
  assert.ok(!calls.some((call) => call.includes('requirements-faster-cuda')));
  const prepared = await prepareLaunch(root, {
    env: {}, nodeDependenciesReady: () => true,
    setupProject: async () => configuration,
    runNpm: (args) => {
      if (args[0] === 'run') {
        fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
        fs.mkdirSync(path.join(root, 'dist-server', 'server'), { recursive: true });
        fs.writeFileSync(path.join(root, 'dist', 'index.html'), 'built');
        fs.writeFileSync(path.join(root, 'dist-server', 'server', 'index.js'), 'built');
      }
    }
  });
  assert.equal(prepared.env.WHISPER_PYTHON_PATH, undefined);
  assert.equal(prepared.env.WHISPER_DEVICE, 'cpu');
  assert.throws(() => setupOptions(['--backend']), /requires a value/);
});
