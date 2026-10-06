import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getRuntimeEnv } from './runtime-env.cjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
Object.assign(process.env, getRuntimeEnv(projectRoot));

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const nodeTests = fs.readdirSync(path.join(projectRoot, 'tests'))
  .filter((name) => /\.test\.(?:ts|mjs)$/.test(name))
  .map((name) => path.join(projectRoot, 'tests', name));
run(process.execPath, [tsxCli, '--test', ...nodeTests]);

const configuredPython = process.env.WHISPER_PYTHON_PATH?.trim();
const venvPython = path.join(
  projectRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
);
const pythonCommand =
  configuredPython || (fs.existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'py' : 'python3');
const pythonPrefix =
  configuredPython || fs.existsSync(venvPython) || process.platform !== 'win32' ? [] : ['-3'];

run(pythonCommand, [...pythonPrefix, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']);
