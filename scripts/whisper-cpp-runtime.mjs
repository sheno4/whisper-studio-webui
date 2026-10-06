import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const WHISPER_CPP_VERSION = '1.9.4';
export const WHISPER_CPP_RELEASE_TAG = `whisper-runtime-v${WHISPER_CPP_VERSION}`;
const DEFAULT_REPOSITORY = 'sheno4/whisper-studio-webui';
const UPSTREAM_BASE = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130';
const CPU_FALLBACKS = {
  'win32-x64': ['whisper-bin-x64.zip', 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'],
  'win32-arm64': ['whisper-bin-win-cpu-arm64.zip', '799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc'],
  'linux-x64': ['whisper-bin-ubuntu-x64.tar.gz', '53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32'],
  'linux-arm64': ['whisper-bin-ubuntu-arm64.tar.gz', '93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6']
};

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const execute = (command, args, options = {}) => new Promise((resolve) => {
  const child = spawn(command, args, {
    cwd: options.cwd, env: options.env, windowsHide: true, shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
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
  child.stdout.on('data', (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (stderr.length < 1024 * 1024) stderr += chunk.toString('utf8'); });
  child.on('error', (error) => finish({ status: null, error }));
  child.on('close', (status) => finish({ status }));
  child.stdin.on('error', () => {});
  child.stdin.end(options.input ?? '');
  const timer = setTimeout(() => { child.kill(); finish({ status: null, error: new Error('Process timed out') }); }, options.timeout ?? 30000);
});

export const whisperCppAsset = (platform = process.platform, arch = process.arch) => {
  if (!['win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Automatic whisper.cpp installation is not available for ${platform}/${arch}. Set WHISPER_CPP_PATH to a compatible whisper-cli executable.`);
  }
  const variant = platform === 'win32' && arch === 'arm64' ? 'cpu' : 'vulkan';
  const osName = { win32: 'windows', linux: 'linux' }[platform];
  return {
    variant,
    filename: `whisper-cpp-v${WHISPER_CPP_VERSION}-${osName}-${arch}-${variant}.${platform === 'win32' ? 'zip' : 'tar.gz'}`
  };
};

export function createWhisperCppRuntime(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetcher = options.fetch ?? globalThis.fetch;
  const run = options.run ?? execute;
  const log = options.logger ?? console.log;
  const wait = options.wait ?? delay;
  const retries = options.retryCount ?? 3;
  const rename = async (from, to) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await fs.rename(from, to); }
      catch (error) {
        if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 7) throw error;
        await wait(250 * (attempt + 1));
      }
    }
  };
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('The native runtime GitHub repository is invalid.');
  const executableName = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

  const probe = async (executable, env) => {
    const directory = path.dirname(executable);
    const probeEnv = platform === 'linux'
      ? { ...env, LD_LIBRARY_PATH: [directory, env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
      : env;
    const result = await run(executable, ['--help'], { env: probeEnv, timeout: 10000 });
    return !result.error && result.status === 0;
  };

  const getToken = async (env) => {
    const supplied = env.WHISPER_GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
    if (supplied) return supplied;
    const token = await run('gh', ['auth', 'token', '--hostname', 'github.com'], { env, timeout: 10000 });
    if (!token.error && token.status === 0 && token.stdout.trim()) return token.stdout.trim();
    // Git Credential Manager is commonly installed with Git for Windows. This
    // reuses permission already needed for an HTTPS clone, without showing UI.
    const credentials = await run('git', ['credential', 'fill'], {
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, timeout: 10000,
      input: `protocol=https\nhost=github.com\npath=${repository}.git\n\n`
    });
    if (credentials.error || credentials.status !== 0) return '';
    const entry = credentials.stdout.split(/\r?\n/).find((line) => line.startsWith('password='));
    return entry?.slice('password='.length).trim() ?? '';
  };

  const request = async (url, token = '', accept = 'application/octet-stream') => {
    let current = new URL(url);
    for (let redirects = 0; redirects < 6; redirects += 1) {
      if (current.protocol !== 'https:' || current.username || current.password) throw new Error('The runtime publisher returned an unsafe download URL.');
      const headers = { Accept: accept, 'User-Agent': 'Whisper-Studio-native-runtime' };
      // A signed release-assets redirect must never receive the GitHub token.
      if (token && ['api.github.com', 'github.com'].includes(current.hostname)) headers.Authorization = `Bearer ${token}`;
      const response = await fetcher(current.href, {
        redirect: 'manual', signal: AbortSignal.timeout(options.downloadTimeoutMs ?? 15 * 60 * 1000), headers
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('The runtime download server returned an invalid redirect.');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        const error = new Error(`Native runtime download server returned HTTP ${response.status}.`);
        error.code = 'DOWNLOAD_HTTP_ERROR';
        error.status = response.status;
        await response.body?.cancel();
        throw error;
      }
      return response;
    }
    throw new Error('The runtime download server returned too many redirects.');
  };

  const readText = async (url, token, accept) => {
    const response = await request(url, token, accept);
    const value = await response.text();
    if (value.length > 2 * 1024 * 1024) throw new Error('Native runtime metadata is unexpectedly large.');
    return value;
  };

  const publisherChecksum = (checksumText, filename) => {
    const matching = checksumText.split(/\r?\n/).map((line) => line.trim().match(/^([a-f\d]{64})\s+\*?(.+)$/i))
      .filter((match) => match?.[2] === filename);
    if (matching.length !== 1) throw new Error(`The publisher did not provide one SHA256 checksum for ${filename}.`);
    return matching[0][1].toLowerCase();
  };

  const projectSource = async (asset, env) => {
    const publicBase = `https://github.com/${repository}/releases/download/${WHISPER_CPP_RELEASE_TAG}`;
    try {
      const checksumText = await readText(`${publicBase}/SHA256SUMS`, '');
      return {
        url: `${publicBase}/${asset.filename}`, filename: asset.filename,
        sha256: publisherChecksum(checksumText, asset.filename), token: '',
        variant: asset.variant, release: WHISPER_CPP_RELEASE_TAG
      };
    } catch (error) {
      // Public releases do not require credentials or the GitHub API quota.
      // Only an access failure can justify trying the private release API.
      if (![401, 403, 404].includes(error.status)) throw error;
    }
    const token = await getToken(env);
    const apiBase = `https://api.github.com/repos/${repository}/releases/tags/${WHISPER_CPP_RELEASE_TAG}`;
    const release = JSON.parse(await readText(apiBase, token, 'application/vnd.github+json'));
    const bundle = release.assets?.find((item) => item.name === asset.filename);
    const sums = release.assets?.find((item) => item.name === 'SHA256SUMS');
    if (!bundle || !sums || !/^https:\/\/api[.]github[.]com\//.test(bundle.url ?? '') || !/^https:\/\/api[.]github[.]com\//.test(sums.url ?? '')) {
      const error = new Error('The native runtime release has not published this platform yet.');
      error.code = 'RUNTIME_NOT_PUBLISHED';
      throw error;
    }
    const checksumText = await readText(sums.url, token);
    return { url: bundle.url, filename: asset.filename, sha256: publisherChecksum(checksumText, asset.filename), token, variant: asset.variant, release: WHISPER_CPP_RELEASE_TAG };
  };

  const publishedSource = async (asset, env) => {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try { return options.source ? await options.source(asset, env) : await projectSource(asset, env); }
      catch (error) {
        // Authentication, missing platforms and invalid metadata require a
        // fallback or a correction; only transport/server failures benefit
        // from another request during the same launch.
        const transient = error.status === 429 || error.status >= 500
          || ['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)
          || ['ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH'].includes(error.code)
          || error.code?.startsWith('UND_ERR_');
        if (!transient || attempt === retries) throw error;
        await wait(attempt * 500);
      }
    }
  };

  const publicCpuSource = () => {
    const fallback = CPU_FALLBACKS[`${platform}-${arch}`];
    return fallback ? { url: `${UPSTREAM_BASE}/${fallback[0]}`, filename: fallback[0], sha256: fallback[1], token: '', variant: 'cpu', release: 'upstream-b5130' } : null;
  };

  const download = async (source, destination) => {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const partial = `${destination}.partial-${randomUUID()}`;
      try {
        log(`Downloading whisper.cpp ${source.variant} runtime${attempt > 1 ? ` (retry ${attempt}/${retries})` : ''}...`);
        const response = await request(source.url, source.token);
        if (!response.body) throw new Error('The runtime download server returned an empty body.');
        const hash = createHash('sha256');
        const hashing = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); done(null, chunk); } });
        await pipeline(Readable.fromWeb(response.body), hashing, createWriteStream(partial, { flags: 'wx' }));
        if (hash.digest('hex') !== source.sha256.toLowerCase()) {
          const error = new Error('whisper.cpp failed SHA256 verification. The previous installation was preserved.');
          error.code = 'CHECKSUM_MISMATCH';
          throw error;
        }
        await fs.rename(partial, destination);
        return;
      } catch (error) {
        await fs.rm(partial, { force: true });
        if (error.code === 'CHECKSUM_MISMATCH' || attempt === retries) throw error;
        await wait(attempt * 500);
      }
    }
  };

  const checkResult = (result, label) => {
    if (result.error || result.status !== 0) throw new Error(`${label} failed. The previous whisper.cpp runtime was preserved.`);
  };

  const extract = options.extract ?? (async (archive, destination, env) => {
    await fs.mkdir(destination, { recursive: true });
    // bsdtar ships with Windows 10/11 and handles both ZIP and tar.gz archives.
    const inventory = await run('tar', ['-tf', archive], { env, timeout: 30000 });
    checkResult(inventory, 'Native runtime archive inspection');
    if (inventory.stdout.split(/\r?\n/).some((entry) => entry.startsWith('/') || entry.startsWith('\\') || /^[a-z]:/i.test(entry) || entry.split(/[\\/]/).includes('..'))) {
      throw new Error('The native runtime archive contains an unsafe path.');
    }
    checkResult(await run('tar', ['-xf', archive, '-C', destination], { env, timeout: 60000 }), 'Native runtime extraction');
  });

  const findExecutable = async (directory, depth = 0) => {
    if (depth > 5) return null;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === executableName)) return path.join(directory, executableName);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = await findExecutable(path.join(directory, entry.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  const validateTree = async (directory, treeRoot = directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (!inside(treeRoot, await fs.realpath(item))) throw new Error('The native runtime contains a symlink outside its bundle.');
      } else if (entry.isDirectory()) await validateTree(item, treeRoot);
    }
  };

  const installedVariant = async (target) => {
    try {
      const marker = JSON.parse(await fs.readFile(path.join(target, 'runtime.json'), 'utf8'));
      if (marker.platform === platform && marker.arch === arch && ['vulkan', 'cpu'].includes(marker.variant)) return marker;
    } catch { /* Unmarked installs must be upgraded before their backend can be trusted. */ }
    return null;
  };

  const hasBackend = async (target, variant) => {
    if (variant === 'cpu') return true;
    try {
      return (await fs.readdir(path.join(target, 'bin')))
        .some((name) => new RegExp(`^(lib)?ggml-${variant}.*[.](dll|so|dylib)([.]\\d+)*$`, 'i').test(name));
    } catch { return false; }
  };

  const ensureWhisperCpp = async (projectRoot, env = process.env) => {
    const configured = env.WHISPER_CPP_PATH?.trim();
    if (configured) {
      if (!await probe(configured, env)) throw new Error('WHISPER_CPP_PATH does not point to a working whisper-cli. Correct it and start again.');
      return { executable: configured, variant: 'custom' };
    }
    let asset = whisperCppAsset(platform, arch);
    if (env.WHISPER_DEVICE?.trim().toLowerCase() === 'cpu' && publicCpuSource()) asset = { ...asset, variant: 'cpu' };
    if (platform === 'linux') {
      let libcVersion = options.glibcVersion ?? (process.platform === 'linux' ? process.report?.getReport()?.header?.glibcVersionRuntime : null);
      if (!libcVersion) {
        const libc = await run('ldd', ['--version'], { env, timeout: 10000 });
        libcVersion = `${libc.stdout}\n${libc.stderr}`.match(/(?:GLIBC|GNU libc|ldd)[^\n]*?\b(\d+[.]\d+)\b/i)?.[1];
      }
      const parts = String(libcVersion ?? '').match(/^(\d+)[.](\d+)/);
      const libc = parts ? Number(parts[1]) * 1000 + Number(parts[2]) : null;
      if (libc === null || libc < 2035) {
        throw new Error('The automatic whisper.cpp Linux runtimes require glibc 2.35 or newer. musl and older distributions need a compatible WHISPER_CPP_PATH; the Python CPU backend remains available.');
      }
      const gpuMinimum = arch === 'arm64' ? 2039 : 2035;
      if (asset.variant !== 'cpu' && libc < gpuMinimum) {
        asset = { ...asset, variant: 'cpu' };
        log(`The ${arch} Vulkan runtime requires glibc 2.39 or newer. Using the compatible public CPU runtime on this system.`);
      }
    }
    const root = await fs.realpath(path.resolve(projectRoot));
    const runtime = path.join(root, '.runtime');
    await fs.mkdir(runtime, { recursive: true });
    if (!inside(root, await fs.realpath(runtime))) throw new Error('The .runtime directory points outside this project.');
    const target = path.join(runtime, 'whisper-cpp');
    try { if (!inside(runtime, await fs.realpath(target))) throw new Error('The whisper.cpp runtime directory points outside this project.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const executable = path.join(target, 'bin', executableName);
    const marker = await installedVariant(target);
    const usable = marker && await hasBackend(target, marker.variant) && await probe(executable, env);
    if (usable && marker.variant === asset.variant && marker.version === WHISPER_CPP_VERSION) return { executable, variant: marker.variant };
    let source;
    if (asset.variant === 'cpu') source = publicCpuSource();
    else {
      try { source = await publishedSource(asset, env); }
      catch (error) {
        if (usable) {
          log(`The updated GPU runtime is currently unavailable. Reusing the working ${marker.variant} runtime; a later launch will retry the upgrade.`);
          return { executable, variant: marker.variant };
        }
        source = publicCpuSource();
        if (!source) {
          const unavailable = new Error('The native runtime could not be downloaded. Check connectivity and the release assets, or set WHISPER_CPP_PATH. Private repositories additionally require GitHub CLI authentication, HTTPS clone credentials, or WHISPER_GITHUB_TOKEN with repository read permission. The Python CPU backend remains available.');
          unavailable.code = 'WHISPER_CPP_RUNTIME_UNAVAILABLE';
          throw unavailable;
        }
        log('The project GPU runtime is currently unavailable. Installing the public CPU runtime; a later launch will retry the automatic GPU upgrade.');
      }
    }
    if (options.source && asset.variant === 'cpu') source = await options.source(asset, env);
    if (!source || !/^[a-f\d]{64}$/i.test(source.sha256 ?? '')) throw new Error('The whisper.cpp download has no valid publisher checksum.');
    const work = await fs.mkdtemp(path.join(runtime, 'whisper-cpp-download-'));
    const backup = path.join(runtime, `whisper-cpp-backup-${randomUUID()}`);
    let movedOld = false;
    try {
      const archive = path.join(work, path.basename(source.filename));
      await download(source, archive);
      const unpacked = path.join(work, 'unpacked');
      await extract(archive, unpacked, env);
      await validateTree(unpacked);
      const discovered = await findExecutable(unpacked);
      if (!discovered) throw new Error('The runtime archive does not contain whisper-cli.');
      let staged;
      if (path.basename(path.dirname(discovered)) === 'bin') staged = path.dirname(path.dirname(discovered));
      else {
        staged = path.join(work, 'ready');
        await fs.mkdir(staged);
        await fs.cp(path.dirname(discovered), path.join(staged, 'bin'), { recursive: true, dereference: true });
      }
      const stagedExecutable = path.join(staged, 'bin', executableName);
      if (platform !== 'win32') await fs.chmod(stagedExecutable, 0o755);
      if (!await hasBackend(staged, source.variant)) throw new Error(`The runtime archive has no ${source.variant} backend library.`);
      if (!await probe(stagedExecutable, env)) throw new Error('The downloaded whisper-cli cannot start on this system. The previous installation was preserved.');
      await fs.writeFile(path.join(staged, 'runtime.json'), JSON.stringify({ version: WHISPER_CPP_VERSION, release: source.release, variant: source.variant, targetVariant: asset.variant, platform, arch }, null, 2));
      try { await rename(target, backup); movedOld = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await rename(staged, target); }
      catch (error) { if (movedOld) await rename(backup, target); movedOld = false; throw error; }
      if (movedOld) await fs.rm(backup, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      log(`Project-local whisper.cpp is ready (${source.variant}).`);
      return { executable, variant: source.variant };
    } finally { await fs.rm(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
  };

  return { ensureWhisperCpp };
}

export const ensureWhisperCpp = createWhisperCppRuntime().ensureWhisperCpp;
