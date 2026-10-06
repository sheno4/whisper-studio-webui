import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getDefaultPythonPath, getProjectRoot, resolveStoredRuntimePaths } from '../src/main/paths';

test.beforeEach((t) => {
  for (const key of ['WHISPER_PYTHON_PATH', 'WHISPER_OUTPUT_DIR']) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
});

test('recovers the missing interpreter and default output folder after moving the project', (t) => {
  t.mock.method(fs, 'existsSync', (candidate) => String(candidate) === getDefaultLocalPython());
  const previousRoot = path.join(os.tmpdir(), 'moved-whisper-fixture', path.basename(getProjectRoot()));
  const previousPython = path.join(previousRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.deepEqual(resolveStoredRuntimePaths({
    pythonPath: previousPython,
    outputDir: path.join(previousRoot, 'outputs')
  }), {
    pythonPath: getDefaultLocalPython(),
    outputDir: path.join(getProjectRoot(), 'outputs')
  });
});

const getDefaultLocalPython = () => path.join(
  getProjectRoot(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);

test('preserves custom interpreter and output paths even if they are missing', () => {
  const stored = {
    pythonPath: path.join(os.tmpdir(), 'custom-python', 'python'),
    outputDir: path.join(os.tmpdir(), 'custom-transcripts')
  };
  assert.deepEqual(resolveStoredRuntimePaths(stored), stored);
});

test('preserves a working interpreter from another checkout', (t) => {
  t.mock.method(fs, 'existsSync', () => true);
  const stored = {
    pythonPath: path.join(os.tmpdir(), 'other', path.basename(getProjectRoot()), '.venv', 'Scripts', 'python.exe'),
    outputDir: path.join(os.tmpdir(), 'other', path.basename(getProjectRoot()), 'outputs')
  };
  assert.deepEqual(resolveStoredRuntimePaths(stored), stored);
});

test('explicit environment variables override previously saved runtime paths', () => {
  process.env.WHISPER_PYTHON_PATH = 'override-python';
  process.env.WHISPER_OUTPUT_DIR = path.join(os.tmpdir(), 'override-output');
  assert.deepEqual(resolveStoredRuntimePaths({ pythonPath: 'old-python', outputDir: 'old-output' }), {
    pythonPath: getDefaultPythonPath(),
    outputDir: path.join(os.tmpdir(), 'override-output')
  });
});
