import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

const UV_VERSION = '0.12.23';
const UV_RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

const execute = (command, args, options = {}) => new Promise((resolve) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ stdout, stderr, ...result });
  };
  child.stdout?.on('data', (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk) => { if (stderr.length < 1024 * 1024) stderr += chunk.toString('utf8'); });
  child.on('error', (error) => finish({ status: null, error }));
  child.on('close', (status) => finish({ status }));
  const timer = options.timeout ? setTimeout(() => {
    child.kill();
    finish({ status: null, error: new Error('Process timed out') });
  }, options.timeout) : undefined;
});

const checksumFor = (text, filename) => {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f\d]{64})(?:\s+\*?(.+))?$/i);
    if (match && (!match[2] || match[2].replace(/^\.\//, '') === filename)) return match[1].toLowerCase();
  }
  throw new Error(`The publisher did not provide a SHA256 checksum for ${filename}.`);
};

export function createPortableTools(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetcher = options.fetch ?? globalThis.fetch;
  const run = options.run ?? execute;
  const log = options.logger ?? console.log;
  const wait = options.wait ?? delay;
  const suffix = platform === 'win32' ? '.exe' : '';
  const retryCount = options.retryCount ?? 3;
  const rename = options.rename ?? fs.rename;
  const assertSupportedPlatform = () => {
    if (platform !== 'win32' && platform !== 'linux') throw new Error(`This project supports Windows and Linux; ${platform} is not supported.`);
  };

  const renameWithRetry = async (source, destination) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await rename(source, destination); }
      catch (error) {
        if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 7) throw error;
        if (attempt === 0) log('Windows is briefly locking the prepared runtime; retrying activation...');
        await wait(Math.min(250 * 2 ** attempt, 2000));
      }
    }
  };

  const checkedRuntime = async (projectRoot) => {
    const root = await fs.realpath(path.resolve(projectRoot));
    const runtime = path.join(root, '.runtime');
    await fs.mkdir(runtime, { recursive: true });
    if (!inside(root, await fs.realpath(runtime))) throw new Error('The .runtime directory points outside this project.');
    return runtime;
  };

  const checkTarget = async (runtime, name) => {
    const target = path.join(runtime, name);
    try {
      if (!inside(runtime, await fs.realpath(target))) throw new Error(`The portable ${name} directory points outside this project.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return target;
  };

  const request = async (url) => {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(options.downloadTimeoutMs ?? 15 * 60 * 1000),
      headers: { 'User-Agent': 'Whisper-Studio-bootstrap' }
    });
    if (!response.ok) throw new Error(`Download server returned HTTP ${response.status}.`);
    return response;
  };

  const fetchText = async (url) => {
    let failure;
    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
      try {
        const response = await request(url);
        const content = await response.text();
        if (content.length > 1024 * 1024) throw new Error('Download metadata is unexpectedly large.');
        return content;
      } catch (error) {
        failure = error;
        if (attempt < retryCount) await wait(attempt * 500);
      }
    }
    throw new Error('Could not read the publisher download metadata. Check your internet connection and retry.', { cause: failure });
  };

  const download = async (source, destination, label) => {
    const filename = source.checksumName ?? new URL(source.url).pathname.split('/').at(-1);
    const expected = source.sha256 ?? checksumFor(await fetchText(source.checksumUrl), filename);
    if (!/^[a-f\d]{64}$/i.test(expected)) throw new Error(`Invalid SHA256 metadata for ${label}.`);
    let failure;
    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
      const partial = `${destination}.partial-${randomUUID()}`;
      try {
        log(`Downloading ${label}${attempt > 1 ? ` (retry ${attempt}/${retryCount})` : ''}...`);
        const response = await request(source.url);
        if (!response.body) throw new Error('The download server returned an empty response.');
        const total = Number(response.headers.get('content-length')) || 0;
        let received = 0;
        let reportedAt = Date.now();
        const hash = createHash('sha256');
        const progress = new Transform({
          transform(chunk, encoding, callback) {
            hash.update(chunk);
            received += chunk.length;
            if (Date.now() - reportedAt >= 2000) {
              const amount = `${(received / 1024 / 1024).toFixed(1)} MB`;
              log(`${label}: ${total ? `${Math.min(100, received / total * 100).toFixed(0)}% (${amount})` : amount}`);
              reportedAt = Date.now();
            }
            callback(null, chunk);
          }
        });
        await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { flags: 'wx' }));
        if (hash.digest('hex') !== expected.toLowerCase()) {
          const error = new Error(`${label} failed SHA256 verification. The existing installation was preserved.`);
          error.code = 'CHECKSUM_MISMATCH';
          throw error;
        }
        await fs.rename(partial, destination);
        log(`${label}: download and SHA256 verification complete.`);
        return;
      } catch (error) {
        failure = error;
        await fs.rm(partial, { force: true });
        if (error.code === 'CHECKSUM_MISMATCH') throw error;
        if (attempt < retryCount) await wait(attempt * 500);
      }
    }
    throw new Error(`Could not download ${label}. Check your internet connection and run the launcher again.`, { cause: failure });
  };

  const requireSuccess = (result, label) => {
    if (result.error || result.status !== 0) throw new Error(`${label} failed${result.status == null ? '' : ` (exit ${result.status})`}. Run the launcher again after resolving the download or runtime error.`, { cause: result.error });
  };

  const extract = options.extract ?? (async (archive, destination, env = process.env) => {
    await fs.mkdir(destination, { recursive: true });
    if (archive.endsWith('.zip') && platform === 'win32') {
      requireSuccess(await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        "$ErrorActionPreference = 'Stop'; $env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath; Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [System.IO.Compression.ZipFile]::OpenRead($env:WHISPER_ARCHIVE_PATH); try { foreach ($entry in $archive.Entries) { $name = $entry.FullName.Replace('\\', '/'); if ($name.StartsWith('/') -or $name.Contains(':') -or ($name.Split('/') -contains '..') -or ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000)) { throw 'The archive contains an unsafe path or symbolic link.' } } } finally { $archive.Dispose() }; Expand-Archive -LiteralPath $env:WHISPER_ARCHIVE_PATH -DestinationPath $env:WHISPER_EXTRACT_PATH -Force"
      ], { env: { ...env, WHISPER_ARCHIVE_PATH: archive, WHISPER_EXTRACT_PATH: destination } }), 'ZIP extraction');
    } else if (archive.endsWith('.zip') && platform === 'linux') {
      // GNU tar cannot unpack ZIP. setup passes its prepared interpreter here,
      // so extracting Chrome does not require an extra distro unzip package.
      const pythonCommand = env.WHISPER_PYTHON_PATH?.trim() || 'python3';
      const source = [
        'import os, stat, sys, zipfile',
        'archive, destination = sys.argv[1:3]',
        'destination = os.path.abspath(destination)',
        'with zipfile.ZipFile(archive) as package:',
        ' entries = package.infolist()',
        ' for entry in entries:',
        '  name = entry.filename.replace("\\\\", "/")',
        '  target = os.path.abspath(os.path.join(destination, name))',
        '  mode = entry.external_attr >> 16',
        '  if name.startswith("/") or ":" in name or ".." in name.split("/") or os.path.commonpath([destination, target]) != destination or stat.S_ISLNK(mode):',
        '   raise RuntimeError("The archive contains an unsafe path or symbolic link.")',
        ' for entry in entries:',
        '  extracted = package.extract(entry, destination)',
        '  mode = (entry.external_attr >> 16) & 0o777',
        '  if mode and not entry.is_dir(): os.chmod(extracted, mode)',
        ' for entry in reversed(entries):',
        '  mode = (entry.external_attr >> 16) & 0o777',
        '  if mode and entry.is_dir(): os.chmod(os.path.join(destination, entry.filename), mode)'
      ].join('\n');
      requireSuccess(await run(pythonCommand, ['-c', source, archive, destination], { env, capture: true, timeout: 180000 }), 'ZIP extraction');
    } else {
      // Callers authenticate the publisher and verify available integrity metadata.
      const list = await run('tar', ['-tf', archive], { env, capture: true, timeout: 30000 });
      requireSuccess(list, 'Archive inspection');
      if (list.stdout.split(/\r?\n/).some((item) => /^[\\/]|^[A-Za-z]:/.test(item) || item.split(/[\\/]/).includes('..'))) {
        throw new Error('The downloaded archive contains an unsafe path.');
      }
      requireSuccess(await run('tar', ['-xf', archive, '-C', destination], { env }), 'Archive extraction');
    }
  });

  const findFile = async (directory, wanted, depth = 0) => {
    if (depth > 4) return null;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && wanted.includes(entry.name)) return path.join(directory, entry.name);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = await findFile(path.join(directory, entry.name), wanted, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  const activate = async (staged, target) => {
    const backup = `${target}.backup-${randomUUID()}`;
    let movedOld = false;
    try {
      try { await renameWithRetry(target, backup); movedOld = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await renameWithRetry(staged, target);
    } catch (error) {
      if (movedOld) await renameWithRetry(backup, target);
      throw error;
    }
    if (movedOld) {
      try { await fs.rm(backup, { recursive: true, force: true }); }
      catch (error) {
        if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        log(`The new runtime is ready. Windows is still locking the previous files; they remain at ${backup}`);
      }
    }
  };

  const probe = async (command, args, env) => {
    const result = await run(command, args, { env, capture: true, timeout: 10000 });
    return !result.error && result.status === 0;
  };

  const python = async (command, args, env) => {
    const result = await run(command, [...args, '-c',
      'import json, sys, venv, ensurepip; print(json.dumps({"version": list(sys.version_info[:2]), "executable": sys.executable}))'
    ], { env: { ...env, PYTHONIOENCODING: 'utf-8' }, capture: true, timeout: 10000 });
    if (result.error || result.status !== 0) return null;
    try {
      const data = JSON.parse(result.stdout.trim());
      if (data.version?.[0] === 3 && data.version[1] >= 14 && typeof data.executable === 'string' && data.executable) {
        return { command: data.executable, args: [] };
      }
    } catch { /* An executable that is not a usable Python is not a bootstrap candidate. */ }
    return null;
  };

  const ensurePythonRuntime = async (projectRoot, env = process.env) => {
    assertSupportedPlatform();
    const configured = env.WHISPER_BOOTSTRAP_PYTHON?.trim();
    if (configured) {
      const selected = await python(configured, [], env);
      if (!selected) throw new Error('WHISPER_BOOTSTRAP_PYTHON does not point to a working Python 3.14+ interpreter with venv support. Correct that setting and run the launcher again.');
      return selected;
    }
    const runtime = await checkedRuntime(projectRoot);
    const pythonDir = await checkTarget(runtime, 'python');
    try {
      const portable = await findFile(pythonDir, platform === 'win32' ? ['python.exe'] : ['python3.14', 'python3', 'python']);
      if (portable) {
        const selected = await python(portable, [], env);
        if (selected) return selected;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const candidates = platform === 'win32'
      ? [['py', ['-3.14']], ['python3.14', []], ['python', []], ['py', ['-3']]]
      : [['python3.14', []], ['python3', []], ['python', []]];
    if (env.WHISPER_PORTABLE_ONLY !== '1') {
      for (const [command, args] of candidates) {
        const selected = await python(command, args, env);
        if (selected) return selected;
      }
    }
    const triples = {
      'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
      'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu'
    };
    const triple = triples[`${platform}-${arch}`];
    if (!triple) throw new Error(`Automatic Python installation is not supported on ${platform}/${arch}. Set WHISPER_BOOTSTRAP_PYTHON to Python 3.14+.`);
    const uvDir = await checkTarget(runtime, 'uv');
    const uv = path.join(uvDir, `uv${suffix}`);
    if (!await probe(uv, ['--version'], env)) {
      const work = await fs.mkdtemp(path.join(runtime, 'uv-download-'));
      try {
        const asset = `uv-${triple}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
        const base = options.uvReleaseBase ?? UV_RELEASE_BASE;
        const archive = path.join(work, asset);
        await download({ url: `${base}/${asset}`, checksumUrl: `${base}/${asset}.sha256` }, archive, `uv ${UV_VERSION}`);
        const unpacked = path.join(work, 'unpacked');
        await extract(archive, unpacked, env);
        const executable = await findFile(unpacked, [`uv${suffix}`]);
        if (!executable || !await probe(executable, ['--version'], env)) throw new Error('The downloaded uv executable could not start. The existing installation was preserved.');
        const staged = path.join(work, 'ready');
        await fs.mkdir(staged);
        await fs.copyFile(executable, path.join(staged, `uv${suffix}`));
        if (platform !== 'win32') await fs.chmod(path.join(staged, 'uv'), 0o755);
        await activate(staged, uvDir);
      } finally { await fs.rm(work, { recursive: true, force: true }); }
    }
    log('Installing project-local Python 3.14. This does not change your system Python...');
    const uvEnv = {
      ...env,
      UV_PYTHON_INSTALL_DIR: pythonDir,
      UV_CACHE_DIR: path.join(runtime, 'uv-cache'),
      UV_PYTHON_INSTALL_BIN: '0',
      UV_NO_CONFIG: '1'
    };
    requireSuccess(await run(uv, [
      'python', 'install', '3.14', '--install-dir', pythonDir, '--no-bin',
      ...(platform === 'win32' ? ['--no-registry'] : []), '--no-config'
    ], { env: uvEnv, cwd: projectRoot }), 'Python installation');
    const located = await run(uv, ['python', 'find', '--managed-python', '--no-python-downloads', '--no-config', '3.14'], { env: uvEnv, cwd: projectRoot, capture: true, timeout: 30000 });
    requireSuccess(located, 'Python discovery');
    const command = located.stdout.trim();
    if (!command || !path.isAbsolute(command) || !inside(pythonDir, command)) throw new Error('uv did not return a Python interpreter inside the project runtime.');
    const selected = await python(command, [], uvEnv);
    if (!selected) throw new Error('The downloaded Python interpreter could not start or has no venv support.');
    return selected;
  };

  const ffmpegSources = () => {
    if (options.ffmpegSources) return options.ffmpegSources;
    if (platform === 'win32' && arch === 'x64') {
      return [{ kind: 'archive', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', checksumUrl: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256' }];
    }
    if ((platform === 'linux' || platform === 'win32') && (arch === 'x64' || arch === 'arm64')) {
      const target = `${platform === 'win32' ? 'win' : 'linux'}${arch === 'arm64' ? 'arm64' : '64'}`;
      const asset = `ffmpeg-n9.0-latest-${target}-gpl-9.0.${platform === 'win32' ? 'zip' : 'tar.xz'}`;
      const base = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
      return [{ kind: 'archive', url: `${base}/${asset}`, checksumUrl: `${base}/checksums.sha256`, checksumName: asset }];
    }
    throw new Error(`Automatic FFmpeg installation is not supported on ${platform}/${arch}. Install both ffmpeg and ffprobe on PATH.`);
  };

  const ensureFfmpeg = async (projectRoot, env = process.env) => {
    assertSupportedPlatform();
    const runtime = await checkedRuntime(projectRoot);
    const target = await checkTarget(runtime, 'ffmpeg');
    const binDir = path.join(target, 'bin');
    const installed = { ffmpeg: path.join(binDir, `ffmpeg${suffix}`), ffprobe: path.join(binDir, `ffprobe${suffix}`), binDir };
    if (await probe(installed.ffmpeg, ['-version'], env) && await probe(installed.ffprobe, ['-version'], env)) return installed;
    if (env.WHISPER_PORTABLE_ONLY !== '1' && await probe('ffmpeg', ['-version'], env) && await probe('ffprobe', ['-version'], env)) return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', binDir: null };
    // A previous launch may have downloaded and validated the package before
    // Windows temporarily prevented renaming its directory. Resume that step.
    for (const entry of await fs.readdir(runtime, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('ffmpeg-download-')) continue;
      const work = path.join(runtime, entry.name);
      let prepared;
      try { prepared = JSON.parse(await fs.readFile(path.join(work, '.prepared.json'), 'utf8')); }
      catch { continue; }
      if (prepared.platform !== platform || prepared.arch !== arch || typeof prepared.staged !== 'string' || path.isAbsolute(prepared.staged)) continue;
      const staged = path.resolve(work, prepared.staged);
      if (!inside(work, staged)) continue;
      try { if (!inside(work, await fs.realpath(staged))) continue; }
      catch { continue; }
      if (!await probe(path.join(staged, 'bin', `ffmpeg${suffix}`), ['-version'], env)
        || !await probe(path.join(staged, 'bin', `ffprobe${suffix}`), ['-version'], env)) continue;
      log('Reusing the previously verified FFmpeg package; no download is needed.');
      try { await activate(staged, target); }
      catch (error) {
        throw new Error(`FFmpeg is prepared but Windows could not release the installation directory (${error.code ?? 'activation failed'}). Run the launcher again; the verified package remains at ${work}`, { cause: error });
      }
      await fs.rm(work, { recursive: true, force: true });
      return installed;
    }
    if (platform === 'linux') {
      const glibc = options.glibcVersion ?? process.report?.getReport()?.header?.glibcVersionRuntime;
      if (glibc && Number(glibc.split('.')[0]) === 2 && Number(glibc.split('.')[1]) < 28) throw new Error('Portable FFmpeg requires glibc 2.28+. Install ffmpeg and ffprobe with your Linux package manager.');
      if (!glibc && !options.ffmpegSources) throw new Error('Portable FFmpeg requires a glibc Linux system. Install ffmpeg and ffprobe with your Linux package manager.');
    }
    const sources = ffmpegSources();
    const work = await fs.mkdtemp(path.join(runtime, 'ffmpeg-download-'));
    let preservePrepared = false;
    try {
      let staged = path.join(work, 'ready');
      await fs.mkdir(path.join(staged, 'bin'), { recursive: true });
      for (const source of sources) {
        const filename = new URL(source.url).pathname.split('/').at(-1);
        const archive = path.join(work, filename);
        await download(source, archive, source.name ?? 'FFmpeg');
        if (source.kind === 'archive') {
          const unpacked = path.join(work, 'unpacked');
          await extract(archive, unpacked, env);
          const executable = await findFile(unpacked, [`ffmpeg${suffix}`]);
          if (!executable || path.basename(path.dirname(executable)) !== 'bin') throw new Error('The downloaded FFmpeg archive has no bin/ffmpeg executable.');
          staged = path.dirname(path.dirname(executable));
        } else if (source.kind === 'gzip') {
          const executable = path.join(staged, 'bin', `${source.name}${suffix}`);
          await pipeline(createReadStream(archive), createGunzip(), createWriteStream(executable));
          await fs.chmod(executable, 0o755);
        } else {
          await fs.copyFile(archive, path.join(staged, source.name));
        }
      }
      if (!await probe(path.join(staged, 'bin', `ffmpeg${suffix}`), ['-version'], env)
        || !await probe(path.join(staged, 'bin', `ffprobe${suffix}`), ['-version'], env)) {
        throw new Error('The downloaded ffmpeg/ffprobe could not start. The existing installation was preserved.');
      }
      await fs.writeFile(path.join(work, '.prepared.json'), JSON.stringify({
        platform, arch, staged: path.relative(work, staged)
      }));
      try { await activate(staged, target); }
      catch (error) {
        preservePrepared = await fs.stat(staged).then((item) => item.isDirectory()).catch(() => false);
        if (!preservePrepared) throw error;
        throw new Error(`FFmpeg is prepared but its installation directory is still locked (${error.code ?? 'activation failed'}). Run the launcher again; the verified package remains at ${work}`, { cause: error });
      }
      log('Project-local FFmpeg and ffprobe are ready.');
      return installed;
    } finally { if (!preservePrepared) await fs.rm(work, { recursive: true, force: true }); }
  };

  return { ensurePythonRuntime, ensureFfmpeg, downloadVerifiedFile: download, extractVerifiedArchive: extract, extractArchive: extract };
}

const portableTools = createPortableTools();
export const ensurePythonRuntime = portableTools.ensurePythonRuntime;
export const ensureFfmpeg = portableTools.ensureFfmpeg;
export const downloadVerifiedFile = portableTools.downloadVerifiedFile;
// Call this only after downloadVerifiedFile has verified the publisher checksum.
export const extractVerifiedArchive = portableTools.extractVerifiedArchive;
// Chrome for Testing publishes TLS URLs and sizes, but no SHA256 manifest.
export const extractArchive = portableTools.extractArchive;
