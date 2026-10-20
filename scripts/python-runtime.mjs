import path from 'node:path';

export const getVenvPython = (projectRoot) => path.join(
  projectRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
);
