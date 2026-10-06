import assert from 'node:assert/strict';
import test from 'node:test';

import { selectedPythonLibraryDirs } from '../scripts/python-libraries.mjs';

test('Linux inspects the selected interpreter purelib and CPU override avoids GPU library loading', () => {
  const python = '/custom/environment/bin/python';
  const env = { PATH: '/custom/environment/bin:/usr/bin', WHISPER_DEVICE: 'auto' };
  const libraries = [
    '/custom/environment/lib/python3.14/site-packages/nvidia/cublas/lib',
    '/custom/environment/lib/python3.14/site-packages/nvidia/cudnn/lib',
    '/custom/environment/lib/python3.14/site-packages/nvidia/cuda_nvrtc/lib'
  ];
  let calls = 0;
  const run = (command, args, options) => {
    calls += 1;
    assert.equal(command, python);
    assert.equal(options.env, env);
    assert.equal(options.shell, false);
    assert.match(args.at(-1), /sysconfig\.get_path\('purelib'\)/);
    assert.doesNotMatch(args.at(-1), /import (?:torch|ctranslate2|nvidia|ctypes)/);
    return { status: 0, stdout: JSON.stringify(libraries), stderr: '' };
  };
  assert.deepEqual(selectedPythonLibraryDirs(python, env, { platform: 'linux', run }), libraries);
  assert.deepEqual(selectedPythonLibraryDirs(python, { ...env, WHISPER_DEVICE: ' CPU ' }, { platform: 'linux', run }), []);
  assert.deepEqual(selectedPythonLibraryDirs(python, env, { platform: 'win32', run }), []);
  assert.equal(calls, 1);
});
