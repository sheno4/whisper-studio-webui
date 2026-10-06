import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVenvPython } from './python-runtime.mjs';
import { getRuntimeEnv } from './runtime-env.cjs';
import { ensurePythonRuntime, ensureFfmpeg } from './portable-tools.mjs';
import { detectHardware, chooseBackend, chooseModel } from './hardware.mjs';
import { selectedPythonLibraryDirs } from './python-libraries.mjs';
import { fingerprint, readBootstrapState, saveBootstrapState, runtimeDirectory, withSetupLock } from './bootstrap-state.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dllPrelude = "import os,sys,sysconfig\n_handles=[]\nif sys.platform=='win32':\n for d in {sys.prefix,sysconfig.get_path('scripts')}:\n  if os.path.isdir(d): _handles.append(os.add_dll_directory(d))\n";

export function setupOptions(args) {
  const options = { cpu: args.includes('--cpu'), skipModel: args.includes('--skip-model'), repair: args.includes('--repair'), cuda: args.includes('--with-faster-cuda') };
  for (let index = 0; index < args.length; index += 1) {
    for (const name of ['backend', 'model']) {
      if (args[index].startsWith(`--${name}=`)) options[name] = args[index].slice(name.length + 3);
      else if (args[index] === `--${name}`) {
        if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`--${name} requires a value.`);
        options[name] = args[++index];
      }
    }
  }
  if (args.includes('--with-whisper')) options.backend = 'whisper';
  if (options.backend !== undefined && !['faster-whisper', 'whisper', 'whisper.cpp'].includes(options.backend)) throw new Error('Choose --backend=faster-whisper, whisper, or whisper.cpp.');
  if (options.model !== undefined && !/^[a-zA-Z0-9.-]+$/.test(options.model)) throw new Error('Specify a supported Whisper model name.');
  return options;
}

export function loadProjectEnv(root) {
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
}

function saveSettings(file, document, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...document, settings: { ...document.settings, ...settings } }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function prefetchModel(root, pythonPath, engine, model, env) {
  console.log(`Preparing ${engine} model ${model}. The first download can take several minutes...`);
  const { prepareModel } = await import('./model-runtime.mjs');
  const result = await prepareModel({ projectRoot: root, pythonPath, engine, model }, {
    env,
    onEvent: (event) => {
      if (event.type === 'progress' && event.message) console.log(event.message);
    }
  });
  return typeof result === 'string' ? result : result.path;
}

export async function setupProject(root = projectRoot, options = {}) {
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('Automatic setup supports Windows and Linux on x64/ARM64.');
  runtimeDirectory(root);
  let env = getRuntimeEnv(root, options.env || process.env);
  const cpu = options.cpu || env.WHISPER_DEVICE?.trim().toLowerCase() === 'cpu';
  if (cpu) env.WHISPER_DEVICE = 'cpu';
  const run = options.run || spawnSync;
  const execute = (command, args, { capture = false, modelDownload = false } = {}) => {
    const result = run(command, args, {
      cwd: root, env, shell: false, windowsHide: true,
      stdio: modelDownload ? ['ignore', 'pipe', 'inherit'] : capture ? 'pipe' : 'inherit',
      encoding: capture || modelDownload ? 'utf8' : undefined,
      timeout: capture ? 30000 : undefined, maxBuffer: 4 * 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${String(result.status)}).${capture && result.stderr ? `\n${result.stderr.slice(-3000)}` : ''}`);
    return result;
  };
  const probe = (pythonPath, imports) => {
    try { execute(pythonPath, ['-X', 'utf8', '-c', dllPrelude + imports], { capture: true }); return true; }
    catch { return false; }
  };
  const settingsFile = path.join(path.resolve(env.WHISPER_DATA_DIR?.trim() || path.join(root, '.data')), 'settings.json');
  let document = { settings: {}, history: [], encryptedApiKeys: {} };
  const existingSettings = fs.existsSync(settingsFile);
  if (existingSettings) {
    // Never overwrite an unreadable settings file containing user data or keys.
    try { document = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
    catch { throw new Error(`Cannot read ${settingsFile}. Repair that JSON before starting setup.`); }
  }
  const hardware = options.hardware || detectHardware({ env });
  let engine = options.backend || document.settings?.transcriptionEngine || chooseBackend(hardware, { ...options, cpu });
  chooseBackend(hardware, { backend: engine });
  let model = options.model || document.settings?.whisperModel || chooseModel(hardware, cpu);
  const ffmpeg = await (options.ensureFfmpeg || ensureFfmpeg)(root, env);
  env = getRuntimeEnv(root, env);
  if (ffmpeg.binDir) {
    const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') || 'PATH';
    env[key] = `${ffmpeg.binDir}${path.delimiter}${env[key] || ''}`;
  }
  const localPython = getVenvPython(root);
  const savedPython = document.settings?.pythonPath?.trim();
  const managedSaved = savedPython && /[\\/]\.venv[\\/](?:Scripts[\\/]python\.exe|bin[\\/]python)$/.test(savedPython);
  const explicitPython = env.WHISPER_PYTHON_PATH?.trim() || (!managedSaved && savedPython);
  const pythonPath = explicitPython ? (/[/\\]/.test(explicitPython) || path.isAbsolute(explicitPython) ? path.resolve(root, explicitPython) : explicitPython) : localPython;
  const runnable = options.canRunPython || ((command) => {
    // Managed installations default to 3.14, but a compatible existing or
    // custom interpreter does not need to be replaced to use the application.
    try { execute(command, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'], { capture: true }); return true; }
    catch { return false; }
  });
  if (!runnable(pythonPath)) {
    if (explicitPython) throw new Error('The configured WHISPER_PYTHON_PATH cannot run Python 3.10+. Correct the interpreter setting, or remove it to use the automatic project environment.');
    const bootstrap = await (options.ensurePythonRuntime || ensurePythonRuntime)(root, env);
    const venv = path.join(root, '.venv');
    if (fs.existsSync(venv)) {
      const resolvedRoot = fs.realpathSync(root);
      if (path.relative(path.join(resolvedRoot, '.venv'), fs.realpathSync(venv)) !== '') throw new Error('.venv points outside this project.');
      const parent = path.join(runtimeDirectory(root), 'venv-backups');
      fs.mkdirSync(parent, { recursive: true });
      if (path.relative(runtimeDirectory(root), fs.realpathSync(parent)).startsWith('..')) throw new Error('The venv backup directory points outside the project.');
      const backup = path.join(parent, `venv-${Date.now()}`);
      fs.renameSync(venv, backup);
      console.log(`Preserved the unusable Python environment at ${backup}`);
    }
    console.log('Creating the project Python environment...');
    execute(bootstrap.command, [...bootstrap.args, '-m', 'venv', venv]);
    if (!runnable(pythonPath)) throw new Error('The new Python virtual environment cannot start.');
    env = getRuntimeEnv(root, env);
  }
  const commonKey = fingerprint(root, ['requirements-common.txt'], `${pythonPath}:${process.platform}:${process.arch}`);
  if (options.repair || readBootstrapState(root).commonKey !== commonKey || !probe(pythonPath, 'import yt_dlp,requests,websocket')) {
    execute(pythonPath, ['-m', 'ensurepip', '--upgrade']);
    execute(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel', '--retries', '5', '--timeout', '60']);
    execute(pythonPath, ['-m', 'pip', 'install', '-r', path.join(root, 'requirements-common.txt'), '--retries', '5', '--timeout', '60']);
    execute(pythonPath, ['-X', 'utf8', '-c', dllPrelude + 'import yt_dlp,requests,websocket'], { capture: true });
    saveBootstrapState(root, { commonKey });
  }
  let native;
  let accelerator = 'cpu';
  if (engine === 'whisper.cpp') {
    try {
      const ensure = options.ensureWhisperCpp || (await import('./whisper-cpp-runtime.mjs')).ensureWhisperCpp;
      native = await ensure(root, env);
      accelerator = cpu ? 'cpu' : native.variant;
      if (native.variant === 'cpu' && !options.model && !document.settings?.whisperModel) model = chooseModel(hardware, true);
    } catch (error) {
      if (options.backend || document.settings?.transcriptionEngine === 'whisper.cpp' || hardware.platform === 'win32' && hardware.arch === 'arm64') throw error;
      console.warn(`Native acceleration could not be prepared: ${error.message}\nPreparing faster-whisper on CPU instead. Run setup again with --backend=whisper.cpp to retry GPU installation.`);
      engine = 'faster-whisper';
      env.WHISPER_DEVICE = 'cpu';
      if (!options.model && !document.settings?.whisperModel) model = chooseModel(hardware, true);
    }
  }
  const cuda = engine === 'faster-whisper' && !cpu && env.WHISPER_DEVICE !== 'cpu' && (options.cuda || hardware.gpus.some((gpu) => gpu.vendor === 'nvidia')) && ['win32', 'linux'].includes(hardware.platform) && ['x64', 'arm64'].includes(hardware.arch);
  if (cuda) accelerator = 'cuda';
  if (engine === 'whisper' && !cpu && hardware.gpus.some((gpu) => gpu.vendor === 'nvidia')) accelerator = 'auto';
  const requirements = engine === 'whisper' ? 'requirements-whisper.txt' : engine === 'whisper.cpp' ? 'requirements-common.txt' : cuda ? 'requirements-faster-cuda.txt' : 'requirements.txt';
  let pythonLibraryDirs = [];
  const prepareLibraries = () => {
    pythonLibraryDirs = selectedPythonLibraryDirs(pythonPath, env, { platform: hardware.platform, run });
    if (pythonLibraryDirs.length) env.LD_LIBRARY_PATH = [...new Set([...pythonLibraryDirs, ...(env.LD_LIBRARY_PATH || '').split(':').filter(Boolean)])].join(':');
  };
  prepareLibraries();
  const dependencyKey = fingerprint(root, ['requirements-common.txt', 'requirements.txt', requirements], `${pythonPath}:${engine}:${cuda}:${process.platform}:${process.arch}`);
  const imports = engine === 'whisper' ? 'import whisper,torch' : engine === 'faster-whisper' ? 'import faster_whisper,ctranslate2,av,onnxruntime' : 'import yt_dlp';
  if (options.repair || readBootstrapState(root).dependencyKey !== dependencyKey || !probe(pythonPath, imports)) {
    if (engine !== 'whisper.cpp') execute(pythonPath, ['-m', 'pip', 'install', '-r', path.join(root, requirements), '--retries', '5', '--timeout', '60']);
    prepareLibraries();
    execute(pythonPath, ['-X', 'utf8', '-c', dllPrelude + imports], { capture: true });
    saveBootstrapState(root, { dependencyKey });
    env = getRuntimeEnv(root, env);
  }
  const ensureBrowser = options.ensureChromiumBrowser || (await import('./browser-runtime.mjs')).ensureChromiumBrowser;
  env.WHISPER_PYTHON_PATH = pythonPath;
  let browserPath = null;
  try { browserPath = await ensureBrowser(root, env); }
  catch (error) {
    if (env.WHISPER_CHROMIUM_PATH?.trim()) throw error;
    console.warn(`Browser preparation failed: ${error.message}\nDouyin browser fallback is unavailable. Core downloading and transcription are ready; rerun setup after fixing the browser dependency or connection.`);
  }
  if (!options.skipModel && !options.deferModel) {
    const modelKey = `${engine}:${model}:${env.HF_HOME}:${env.HF_HUB_CACHE || ''}:${env.HUGGINGFACE_HUB_CACHE || ''}:${env.XDG_CACHE_HOME}:${env.WHISPER_CPP_MODEL_DIR || ''}`;
    const saved = readBootstrapState(root);
    const nonempty = (file) => { try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch { return false; } };
    const cached = saved.modelKey === modelKey && saved.modelPath && fs.existsSync(saved.modelPath) && (fs.statSync(saved.modelPath).isDirectory() ? ['model.bin', 'config.json'].every((name) => nonempty(path.join(saved.modelPath, name))) : nonempty(saved.modelPath));
    if (!cached) {
      const modelPath = await (options.prefetchModel || prefetchModel)(root, pythonPath, engine, model, env, execute);
      if (!modelPath || !fs.existsSync(modelPath)) throw new Error('The model download did not produce a usable local path.');
      saveBootstrapState(root, { modelKey, modelPath });
    }
  }
  const settings = !existingSettings ? { pythonPath, transcriptionEngine: engine, whisperModel: model } : {
    ...(managedSaved ? { pythonPath } : {}),
    ...(options.backend ? { transcriptionEngine: engine } : {}),
    ...(options.model ? { whisperModel: model } : {})
  };
  if (Object.keys(settings).length) saveSettings(settingsFile, document, settings);
  const configuration = { pythonPath, engine, model, accelerator, hardware, browserPath, cppPath: native?.executable, pythonLibraryDirs, cpu: cpu || env.WHISPER_DEVICE === 'cpu', modelDeferred: Boolean(options.skipModel || options.deferModel) };
  saveBootstrapState(root, { configuration });
  const modelNote = options.skipModel ? ' (download skipped; tasks prepare it on demand)' : options.deferModel ? ' (prepared after the service starts)' : '';
  console.log(`Environment ready: ${engine}, ${accelerator}, model ${model}${modelNote}.`);
  return configuration;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    loadProjectEnv(projectRoot);
    await withSetupLock(projectRoot, () => setupProject(projectRoot, setupOptions(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
