import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canRunPython } from '../scripts/python-runtime.mjs';

test('an existing but unusable interpreter triggers setup', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-python-probe-'));
  const executable = path.join(fixture, 'python.exe');
  try {
    fs.writeFileSync(executable, 'not an executable');
    assert.equal(fs.existsSync(executable), true);
    assert.equal(canRunPython(executable), false);
  } finally {
    fs.unlinkSync(executable);
    fs.rmdirSync(fixture);
  }
});
