import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const getVenvPython = (projectRoot) => path.join(
  projectRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
);

export const canRunPython = (command, args = [], env = process.env) => {
  const result = spawnSync(command, [
    ...args,
    '-c',
    'import sys; raise SystemExit(0 if sys.version_info >= (3, 14) else 1)'
  ], {
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
    env,
    timeout: 10000
  });
  return !result.error && result.status === 0;
};
