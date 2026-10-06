const fs = require('node:fs');
const path = require('node:path');

// Prefer the project's portable tools while retaining the rest of the user's PATH.
exports.getRuntimeEnv = (projectRoot, environment = process.env) => {
  const result = { ...environment };
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const directories = [
    [path.join(projectRoot, '.runtime', 'node'), `node${suffix}`],
    [path.join(projectRoot, '.runtime', 'ffmpeg', 'bin'), `ffmpeg${suffix}`]
  ].filter(([directory, executable]) => fs.existsSync(path.join(directory, executable)))
    .map(([directory]) => directory);
  const pathKey = Object.keys(result).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const previous = (result[pathKey] || '').split(path.delimiter).filter(Boolean);
  result[pathKey] = [...new Set([...directories, ...previous])].join(path.delimiter);
  return result;
};
