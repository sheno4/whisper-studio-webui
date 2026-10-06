import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRuntimeEnv } from './runtime-env.cjs';
import { getVenvPython } from './python-runtime.mjs';
import { createWhisperCppRuntime } from './whisper-cpp-runtime.mjs';

const ENGINES = new Set(['faster-whisper', 'whisper', 'whisper.cpp']);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const dllPrelude = "import os,sys,sysconfig\n_handles=[]\nif sys.platform=='win32':\n for d in {sys.prefix,sysconfig.get_path('scripts')}:\n  if os.path.isdir(d): _handles.append(os.add_dll_directory(d))\n";
const modelError = (code, message) => Object.assign(new Error(message), { code });

function safeMessage(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/https?:\/\/[^\s)]+/gi, (raw) => {
      try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}`; }
      catch { return '[download URL]'; }
    }).slice(0, 1600);
}

// Children stay in the caller's process group. The server owns cancellation
// and can terminate the runner, pip and Python download as one process tree.
export function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, windowsHide: true, shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let stdoutLine = '';
    let stderrLine = '';
    let finished = false;
    let timedOut = false;
    const limit = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const record = (chunk, stream) => {
      const value = chunk.toString('utf8');
      if (stream === 'stdout') stdout = (stdout + value).slice(-limit);
      else stderr = (stderr + value).slice(-limit);
      const lines = ((stream === 'stdout' ? stdoutLine : stderrLine) + value).split(/[\r\n]+/);
      const tail = lines.pop() ?? '';
      if (stream === 'stdout') stdoutLine = tail;
      else stderrLine = tail;
      for (const line of lines) if (line.trim()) options.onLine?.(line, stream);
    };
    child.stdout.on('data', (chunk) => record(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => record(chunk, 'stderr'));
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (stdoutLine.trim()) options.onLine?.(stdoutLine, 'stdout');
      if (stderrLine.trim()) options.onLine?.(stderrLine, 'stderr');
      resolve({ stdout, stderr, ...result });
    };
    child.on('error', (error) => finish({ status: null, error }));
    child.on('close', (status) => finish({ status, ...(timedOut ? { error: modelError('MODEL_PROCESS_TIMEOUT', '准备模型的子进程超时，请重试。') } : {}) }));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    const timer = options.timeout ? setTimeout(() => { timedOut = true; child.kill(); }, options.timeout) : undefined;
  });
}

export async function withRuntimeLock(root, key, operation, onEvent = () => {}, options = {}) {
  const directory = path.join(root, '.runtime', 'locks');
  await fs.mkdir(directory, { recursive: true });
  const lock = path.join(directory, `model-${createHash('sha256').update(key).digest('hex')}.lock`);
  const token = randomUUID();
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000);
  let notified = false;
  while (true) {
    try {
      const handle = await fs.open(lock, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await fs.readFile(lock, 'utf8')); } catch { /* Owner may still be writing. */ }
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (failure) { alive = failure.code !== 'ESRCH'; }
        if (!alive) { await fs.rm(lock, { force: true }); continue; }
      } else {
        try {
          if (Date.now() - (await fs.stat(lock)).mtimeMs > 30_000) { await fs.rm(lock, { force: true }); continue; }
        } catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
      }
      if (Date.now() > deadline) throw modelError('MODEL_LOCK_TIMEOUT', '另一进程仍在准备模型环境，请等待其完成或取消后重试。');
      if (!notified) { onEvent({ type: 'progress', message: '另一进程正在准备相同环境，等待其完成' }); notified = true; }
      await (options.wait ?? wait)(250);
    }
  }
  try { return await operation(); }
  finally {
    try { if (JSON.parse(await fs.readFile(lock, 'utf8')).token === token) await fs.rm(lock, { force: true }); }
    catch { /* Do not delete another owner's lock. */ }
  }
}

/** Prepare just the requested backend and weights, without changing settings. */
export async function prepareModel(request, options = {}) {
  if (!request || typeof request.projectRoot !== 'string' || !request.projectRoot.trim() || !ENGINES.has(request.engine) || typeof request.model !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(request.model)) {
    throw modelError('MODEL_REQUEST_INVALID', '模型准备请求缺少有效的项目路径、引擎或模型。');
  }
  const root = await fs.realpath(path.resolve(request.projectRoot));
  let env = { ...getRuntimeEnv(root, options.env ?? process.env), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  const configured = request.pythonPath?.trim() || env.WHISPER_PYTHON_PATH?.trim() || getVenvPython(root);
  const pythonPath = /[/\\]/.test(configured) || path.isAbsolute(configured) ? path.resolve(root, configured) : configured;
  const run = options.run ?? runProcess;
  const event = (payload) => options.onEvent?.({ ...payload, message: safeMessage(payload.message) });
  const invoke = (command, args, extra = {}) => run(command, args, { cwd: root, env, ...extra });
  const probe = await invoke(pythonPath, ['-X', 'utf8', '-c', 'import sys; print(sys.version_info.major)'], { timeout: 15_000 });
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== '3') throw modelError('MODEL_PYTHON_UNAVAILABLE', '所选 Python 无法启动，请在设置中修正解释器路径后重试；模型准备不会替换自定义解释器。');
  let cuda = false;
  if (request.engine === 'faster-whisper' && env.WHISPER_DEVICE?.trim().toLowerCase() !== 'cpu') {
    const gpu = await invoke('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 10_000 });
    cuda = !gpu.error && gpu.status === 0 && Boolean(gpu.stdout.trim());
  }
  const imports = request.engine === 'whisper' ? 'import whisper,torch' : request.engine === 'faster-whisper'
    ? 'import faster_whisper,ctranslate2,av,onnxruntime' + (cuda ? "\nimport importlib.metadata as _m\n_m.version('nvidia-cublas-cu12')\n_m.version('nvidia-cudnn-cu12')" : '') : 'import sys';
  const probeImports = () => invoke(pythonPath, ['-X', 'utf8', '-c', dllPrelude + imports], { timeout: 45_000 });
  let pythonLibraryDirs = [];
  const prepareLibraries = async () => {
    if ((options.platform ?? process.platform) !== 'linux' || env.WHISPER_DEVICE?.trim().toLowerCase() === 'cpu') return;
    const result = await invoke(pythonPath, ['-X', 'utf8', '-c', "import json,sysconfig\nfrom pathlib import Path\np=Path(sysconfig.get_path('purelib'))/'nvidia'\nprint(json.dumps([str(d/'lib') for d in p.iterdir() if (d/'lib').is_dir()] if p.is_dir() else []))"], { timeout: 15_000 });
    if (result.error || result.status !== 0) throw modelError('MODEL_LIBRARY_PROBE_FAILED', '无法读取所选 Python 的加速库目录，请检查解释器后重试。');
    let libraries;
    try { libraries = JSON.parse(result.stdout.trim()); } catch { /* Checked below. */ }
    if (!Array.isArray(libraries) || libraries.some((directory) => typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0'))) throw modelError('MODEL_LIBRARY_PROBE_FAILED', '所选 Python 返回了无效的加速库目录。');
    pythonLibraryDirs = libraries;
    if (libraries.length) env.LD_LIBRARY_PATH = [...new Set([...libraries, ...(env.LD_LIBRARY_PATH || '').split(':').filter(Boolean)])].join(':');
  };
  await prepareLibraries();
  if (request.engine !== 'whisper.cpp') {
    await withRuntimeLock(root, `python:${pythonPath}`, async () => {
      let installed = await probeImports();
      if (installed.error || installed.status !== 0) {
        event({ type: 'progress', message: `正在为所选 Python 安装 ${request.engine} 依赖` });
        const requirements = request.engine === 'whisper' ? 'requirements-whisper.txt' : cuda ? 'requirements-faster-cuda.txt' : 'requirements.txt';
        const pip = await invoke(pythonPath, ['-m', 'pip', '--version'], { timeout: 15_000 });
        if (pip.error || pip.status !== 0) {
          const bootstrap = await invoke(pythonPath, ['-m', 'ensurepip'], { timeout: 60_000 });
          if (bootstrap.error || bootstrap.status !== 0) throw modelError('MODEL_PIP_UNAVAILABLE', '所选 Python 缺少 pip，且无法自动安装，请选择可用的 Python 环境。');
        }
        const installation = await invoke(pythonPath, ['-m', 'pip', 'install', '-r', path.join(root, requirements), '--retries', '3', '--timeout', '60', '--disable-pip-version-check'], {
          onLine: (line) => event({ type: 'progress', message: line }), timeout: 30 * 60_000
        });
        if (installation.error || installation.status !== 0) throw modelError('MODEL_DEPENDENCY_INSTALL_FAILED', '所选引擎的依赖安装失败，请检查网络或 Python 环境后重试。');
        env = getRuntimeEnv(root, env);
        await prepareLibraries();
        installed = await probeImports();
        if (installed.error || installed.status !== 0) throw modelError('MODEL_DEPENDENCY_UNAVAILABLE', '所选引擎安装后仍无法导入，请检查 Python 环境和运行库后重试。');
      }
    }, event, options.lockOptions);
  } else {
    await withRuntimeLock(root, 'native:whisper.cpp', async () => {
      event({ type: 'progress', message: '正在检查 whisper.cpp 运行环境' });
      const ensure = options.ensureWhisperCpp ?? createWhisperCppRuntime({ logger: (message) => event({ type: 'progress', message }) }).ensureWhisperCpp;
      await ensure(root, env);
    }, event, options.lockOptions);
  }
  event({ type: 'progress', message: `正在准备 ${request.engine} 模型：${request.model}` });
  let downloaded;
  let failure;
  const result = await invoke(pythonPath, ['-X', 'utf8', path.join(root, 'python', 'model_download.py')], {
    input: JSON.stringify({ projectRoot: root, engine: request.engine, model: request.model }),
    onLine: (line, stream) => {
      if (stream !== 'stdout') return;
      let payload;
      try { payload = JSON.parse(line); } catch { return; }
      if (payload?.type === 'progress' && typeof payload.message === 'string') event(payload);
      else if (payload?.type === 'result' && typeof payload.path === 'string') downloaded = payload.path;
      else if (payload?.type === 'error' && typeof payload.message === 'string') failure = modelError(payload.code ?? 'MODEL_DOWNLOAD_FAILED', safeMessage(payload.message));
    }
  });
  // Injectable runners may return buffered output without line callbacks.
  if (!downloaded && !failure) for (const line of result.stdout.split(/\r?\n/)) {
    try {
      const payload = JSON.parse(line);
      if (payload.type === 'result' && typeof payload.path === 'string') downloaded = payload.path;
      else if (payload.type === 'error') failure = modelError(payload.code ?? 'MODEL_DOWNLOAD_FAILED', safeMessage(payload.message));
    } catch { /* Only complete protocol records are usable. */ }
  }
  if (failure) throw failure;
  if (result.error || result.status !== 0 || !downloaded) throw modelError('MODEL_DOWNLOAD_FAILED', '模型准备没有完成，请检查网络和所选 Python 环境后重试。');
  const modelPath = path.resolve(downloaded);
  const stat = await fs.stat(modelPath).catch(() => null);
  if (!stat || !(stat.isDirectory() || stat.isFile() && stat.size > 0)) throw modelError('MODEL_DOWNLOAD_INCOMPLETE', '模型下载未生成完整缓存，请重试。');
  return { path: modelPath, ...(pythonLibraryDirs.length ? { pythonLibraryDirs } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const emit = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString('utf8');
      if (input.length > 1024 * 1024) throw modelError('MODEL_REQUEST_INVALID', '模型准备请求过大。');
    }
    const result = await prepareModel(JSON.parse(input), { onEvent: emit });
    emit({ type: 'result', ...result });
  } catch (error) {
    emit({ type: 'error', message: safeMessage(error.message ?? '模型准备失败，请重试。'), code: error.code ?? 'MODEL_PREPARATION_FAILED' });
    process.exitCode = 1;
  }
}
