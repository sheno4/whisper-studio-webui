const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Prefer the project's portable tools while retaining the rest of the user's PATH.
exports.getRuntimeEnv = (projectRoot, environment = process.env) => {
  const result = { ...environment };
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const directories = [
    [path.join(projectRoot, '.runtime', 'node'), `node${suffix}`],
    [path.join(projectRoot, '.runtime', 'node', 'bin'), `node${suffix}`],
    [path.join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'), process.platform === 'win32' ? 'python.exe' : 'python'],
    [path.join(projectRoot, '.runtime', 'ffmpeg', 'bin'), `ffmpeg${suffix}`]
  ].filter(([directory, executable]) => fs.existsSync(path.join(directory, executable)))
    .map(([directory]) => directory);
  const pathKey = Object.keys(result).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const previous = (result[pathKey] || '').split(path.delimiter).filter(Boolean);
  result[pathKey] = [...new Set([...directories, ...previous])].join(path.delimiter);
  const cacheRoot = path.join(projectRoot, '.runtime', 'cache');
  const existingCache = path.join(os.homedir(), '.cache');
  result.HF_HOME ||= fs.existsSync(path.join(existingCache, 'huggingface'))
    ? path.join(existingCache, 'huggingface') : path.join(cacheRoot, 'huggingface');
  result.XDG_CACHE_HOME ||= fs.existsSync(path.join(existingCache, 'whisper')) ? existingCache : cacheRoot;
  result.PIP_CACHE_DIR ||= path.join(projectRoot, '.runtime', 'pip-cache');
  if (process.platform === 'linux') {
    const libraryRoot = path.join(projectRoot, '.venv', 'lib');
    const libraries = fs.existsSync(libraryRoot) ? fs.readdirSync(libraryRoot)
      .filter((name) => name.startsWith('python'))
      .flatMap((name) => ['cublas', 'cudnn', 'cuda_nvrtc'].map((library) => path.join(libraryRoot, name, 'site-packages', 'nvidia', library, 'lib')))
      .filter((directory) => fs.existsSync(directory)) : [];
    if (libraries.length) result.LD_LIBRARY_PATH = [...new Set([...libraries, ...(result.LD_LIBRARY_PATH || '').split(':').filter(Boolean)])].join(':');
  }
  return result;
};
