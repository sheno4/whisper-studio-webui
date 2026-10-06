import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probeOutputDirectory, runEnvironmentCheck } from '../src/main/environment';
import type { SettingsData } from '../src/shared/types';

const settings: SettingsData = {
  pythonPath: 'missing-python', outputDir: os.tmpdir(), transcriptionEngine: 'whisper',
  whisperModel: 'large-v3-turbo', translateByDefault: false, translationServices: [],
  keepAudio: true, logLevel: 'info', debugMode: false
};

test('a broken Python does not make an available FFmpeg look missing', async (t) => {
  t.mock.method(fs, 'mkdir', async () => undefined);
  const result = await runEnvironmentCheck(settings, async (command: string) => {
    if (command === 'ffmpeg') {
      return { code: 0, stdout: 'ffmpeg version fixture\nconfiguration: test', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'did not find executable at old/base/python.exe' };
  });
  assert.equal(result.items.find((item) => item.key === 'ffmpeg')?.ok, true);
  assert.match(result.items.find((item) => item.key === 'python')!.details, /old\/base\/python.exe/);
  for (const key of ['transcription_engine', 'yt_dlp']) {
    assert.match(result.items.find((item) => item.key === key)!.details, /Not checked/);
    assert.match(result.items.find((item) => item.key === key)!.suggestion!, /Fix the Python/);
  }
});

test('a failed worker is not accepted even when it emits JSON', async (t) => {
  t.mock.method(fs, 'mkdir', async () => undefined);
  const result = await runEnvironmentCheck(settings, async (_command: string, args: string[]) => {
    if (args.includes('env-check')) {
      return { code: 1, stdout: '{"whisperOk":true,"ytDlpOk":true}', stderr: 'worker crashed' };
    }
    return { code: 0, stdout: 'version fixture', stderr: '' };
  });
  assert.equal(result.items.find((item) => item.key === 'python_worker')?.details, 'worker crashed');
  assert.equal(result.items.find((item) => item.key === 'transcription_engine')?.ok, false);
});

test('an FFmpeg executable that exits with an error is reported as unusable', async (t) => {
  t.mock.method(fs, 'mkdir', async () => undefined);
  const result = await runEnvironmentCheck(settings, async (command: string) => {
    if (command === 'ffmpeg') {
      return { code: 1, stdout: '', stderr: 'ffmpeg DLL missing' };
    }
    throw new Error('spawn ENOENT');
  });
  assert.equal(result.items.find((item) => item.key === 'ffmpeg')?.ok, false);
  assert.equal(result.items.find((item) => item.key === 'ffmpeg')?.details, 'ffmpeg DLL missing');
});

test('an existing output directory is unhealthy when file creation is denied', async (t) => {
  t.mock.method(fs, 'mkdir', async () => undefined);
  t.mock.method(fs, 'open', async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
  const result = await runEnvironmentCheck(settings, async () => ({ code: 1, stdout: '', stderr: 'fixture' }));
  assert.equal(result.items.find((item) => item.key === 'output_dir')?.ok, false);
});

test('output directory probes leave no files behind', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-write-check-'));
  try {
    await probeOutputDirectory(directory);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rmdir(directory);
  }
});
