import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canRunPython, getVenvPython } from './python-runtime.mjs';
import { getRuntimeEnv } from './runtime-env.cjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
Object.assign(process.env, getRuntimeEnv(projectRoot));
const venvDir = path.join(projectRoot, '.venv');
const venvPython = getVenvPython(projectRoot);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${String(result.status)}.`);
  }
};

// Respect the same .env bootstrap/data-directory settings as the launcher.
const { config } = await import('dotenv');
config({ path: path.join(projectRoot, '.env'), quiet: true });

const configuredPython = process.env.WHISPER_BOOTSTRAP_PYTHON?.trim();
const candidates = configuredPython
  ? [{ command: configuredPython, args: [] }]
  : process.platform === 'win32'
    ? [{ command: 'py', args: ['-3.14'] }, { command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];

if (!canRunPython(venvPython)) {
  const bootstrap = candidates.find((candidate) => canRunPython(candidate.command, candidate.args));
  if (!bootstrap) {
    console.error('Python 3.14 was not found. Install Python 3.14, then run npm run setup again.');
    process.exit(1);
  }

  if (fs.existsSync(venvDir)) {
    // Virtual environments contain absolute interpreter paths. Keep the old
    // environment as a backup before recreating a broken or moved environment.
    const resolvedRoot = fs.realpathSync(projectRoot);
    const expectedVenv = path.join(resolvedRoot, '.venv');
    if (path.relative(expectedVenv, fs.realpathSync(venvDir)) !== '') {
      throw new Error('The .venv directory points outside this project. Configure WHISPER_PYTHON_PATH instead.');
    }
    const backupParent = path.join(resolvedRoot, '.runtime', 'venv-backups');
    fs.mkdirSync(backupParent, { recursive: true });
    const relativeBackup = path.relative(resolvedRoot, fs.realpathSync(backupParent));
    if (relativeBackup.startsWith('..') || path.isAbsolute(relativeBackup)) {
      throw new Error('The virtual environment backup directory points outside this project.');
    }
    const backupDir = path.join(backupParent, `venv-${Date.now()}`);
    fs.renameSync(venvDir, backupDir);
    console.log(`Backed up the unusable Python environment to ${backupDir}`);
  }

  console.log(`Creating virtual environment at ${venvDir}`);
  run(bootstrap.command, [...bootstrap.args, '-m', 'venv', venvDir]);
}

console.log('Updating pip tooling...');
run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel']);

console.log('Installing Whisper Studio Python dependencies...');
let useWhisper = process.argv.includes('--with-whisper');
try {
  const dataDir = path.resolve(process.env.WHISPER_DATA_DIR?.trim() || path.join(projectRoot, '.data'));
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  useWhisper ||= stored.settings?.transcriptionEngine === 'whisper';
} catch {
  // A new installation uses the default faster-whisper backend.
}
const requirementsFile = useWhisper ? 'requirements-whisper.txt' : 'requirements.txt';
run(venvPython, ['-m', 'pip', 'install', '-r', path.join(projectRoot, requirementsFile)]);
if (process.argv.includes('--with-faster-cuda')) {
  run(venvPython, ['-m', 'pip', 'install', '-r', path.join(projectRoot, 'requirements-faster-cuda.txt')]);
}

const ffmpegProbe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', shell: false });
if (ffmpegProbe.error || ffmpegProbe.status !== 0) {
  console.warn('\nFFmpeg is not on PATH. Install it before downloading or processing media.');
} else {
  console.log('FFmpeg detected.');
}

console.log('\nSetup complete. Run npm run dev, then open http://127.0.0.1:5173.');
