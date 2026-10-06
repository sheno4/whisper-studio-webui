import { spawnSync } from 'node:child_process';

// Linux resolves LD_LIBRARY_PATH when Python starts. Inspect the selected
// interpreter without importing a GPU package, then pass these directories to
// the worker's process environment before it starts loading native libraries.
const libraryProbe = [
  'import json, sysconfig',
  'from pathlib import Path',
  "root = Path(sysconfig.get_path('purelib')) / 'nvidia'",
  "print(json.dumps([str(package / 'lib') for package in sorted(root.iterdir()) if (package / 'lib').is_dir()] if root.is_dir() else []))"
].join('\n');

export function selectedPythonLibraryDirs(pythonPath, env = process.env, options = {}) {
  if ((options.platform ?? process.platform) !== 'linux' || env.WHISPER_DEVICE?.trim().toLowerCase() === 'cpu') return [];
  const run = options.run ?? spawnSync;
  const result = run(pythonPath, ['-X', 'utf8', '-c', libraryProbe], {
    env, encoding: 'utf8', shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000
  });
  if (result.error || result.status !== 0) {
    throw new Error('Could not inspect NVIDIA library directories in the selected Python environment.');
  }
  let directories;
  try { directories = JSON.parse(result.stdout.trim()); }
  catch { throw new Error('The selected Python returned invalid NVIDIA library metadata.'); }
  if (!Array.isArray(directories) || directories.some((directory) => typeof directory !== 'string' || !directory.startsWith('/') || directory.includes('\0'))) {
    throw new Error('The selected Python returned invalid NVIDIA library directories.');
  }
  return [...new Set(directories)];
}
