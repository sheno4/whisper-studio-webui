import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runEnvironmentCheck } from '../src/main/environment';
import { parseSaveSettings } from '../src/server/validation';
import { FASTER_WHISPER_MODEL_OPTIONS, WHISPER_CPP_MODEL_OPTIONS } from '../src/shared/constants';
import type { SettingsData } from '../src/shared/types';

const settings: SettingsData = {
  pythonPath: 'python-fixture', outputDir: os.tmpdir(), transcriptionEngine: 'whisper.cpp',
  whisperModel: 'turbo', translateByDefault: false, translationServices: [],
  keepAudio: true, logLevel: 'info', debugMode: false
};

test('whisper.cpp accepts its GGML aliases and rejects CTranslate2-only models', () => {
  for (const whisperModel of WHISPER_CPP_MODEL_OPTIONS) {
    assert.equal(parseSaveSettings({ ...settings, whisperModel }).transcriptionEngine, 'whisper.cpp');
  }
  for (const whisperModel of FASTER_WHISPER_MODEL_OPTIONS.filter((model) => model.startsWith('distil-'))) {
    assert.throws(() => parseSaveSettings({ ...settings, whisperModel }), /GGML model/);
    assert.equal(parseSaveSettings({ ...settings, transcriptionEngine: 'faster-whisper', whisperModel }).whisperModel, whisperModel);
  }
});

test('native diagnostics do not require Torch or CTranslate2 and pass the selected model', async (t) => {
  t.mock.method(fs, 'mkdir', async () => undefined);
  const result = await runEnvironmentCheck(settings, async (_command, args, options) => {
    if (args.includes('env-check')) {
      assert.equal(options?.env?.WHISPER_ENGINE, 'whisper.cpp');
      assert.equal(options?.env?.WHISPER_MODEL, 'turbo');
      return { code: 0, stdout: JSON.stringify({
        whisperOk: false, fasterWhisperOk: false, ytDlpOk: true,
        whisperCppOk: true, whisperCppModelOk: true,
        whisperCppPath: 'native/whisper-cli', whisperCppModelPath: 'models/ggml-large-v3-turbo.bin'
      }), stderr: '' };
    }
    return { code: 0, stdout: 'fixture version', stderr: '' };
  });
  const item = result.items.find((item) => item.key === 'transcription_engine')!;
  assert.equal(item.ok, true);
  assert.match(item.details, /ggml-large-v3-turbo/);
});

test('native diagnostics report missing models even when the CLI starts', async (t) => {
  t.mock.method(fs, 'mkdir', async () => undefined);
  const result = await runEnvironmentCheck(settings, async (_command, args) => ({
    code: 0, stderr: '', stdout: args.includes('env-check')
      ? JSON.stringify({ whisperCppOk: true, whisperCppModelOk: false, whisperCppModelPath: 'missing-model.bin' })
      : 'fixture version'
  }));
  const item = result.items.find((item) => item.key === 'transcription_engine')!;
  assert.equal(item.ok, false);
  assert.match(item.details, /missing-model.bin/);
  assert.match(item.suggestion!, /restart/);
});

test('saving and reloading settings preserves the native engine', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-cpp-settings-'));
  const previous = process.env.WHISPER_DATA_DIR;
  process.env.WHISPER_DATA_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.WHISPER_DATA_DIR;
    else process.env.WHISPER_DATA_DIR = previous;
    await fs.unlink(path.join(directory, 'settings.json'));
    await fs.rmdir(directory);
  });
  const { getSettingsView, saveSettingsView } = await import('../src/main/store');
  saveSettingsView({ ...getSettingsView(), transcriptionEngine: 'whisper.cpp', whisperModel: 'tiny' });
  const reloaded = getSettingsView();
  assert.equal(reloaded.transcriptionEngine, 'whisper.cpp');
  assert.equal(reloaded.whisperModel, 'tiny');
});
