import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createPortableTools } from './portable-tools.mjs';

const METADATA_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const execute = (command, args, options) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let settled = false;
  const child = spawn(command, args, { env: options.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ stdout, stderr, ...result });
  };
  child.stdout.on('data', (chunk) => { if (stdout.length < 65536) stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk.toString('utf8'); });
  child.on('error', (error) => finish({ error, status: null }));
  child.on('close', (status) => finish({ status }));
  const timer = setTimeout(() => {
    child.kill();
    finish({ error: new Error('Browser version probe timed out'), status: null });
  }, options.timeout ?? 10000);
});

export function createBrowserRuntime(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetcher = options.fetch ?? globalThis.fetch;
  const run = options.run ?? execute;
  const log = options.logger ?? console.log;
  const retryWait = options.wait ?? wait;
  const attempts = options.retryCount ?? 3;
  const archiveTools = createPortableTools({ platform, arch, run: options.archiveRun, logger: log });
  const extract = options.extract ?? archiveTools.extractArchive;
  const targetPlatform = {
    'win32-x64': 'win64', 'win32-arm64': 'win64',
    'linux-x64': 'linux64', 'linux-arm64': 'linux-arm64'
  }[`${platform}-${arch}`];

  const relativeExecutable = (assetPlatform) => {
    if (assetPlatform.startsWith('win')) return path.join(`chrome-${assetPlatform}`, 'chrome.exe');
    return path.join(`chrome-${assetPlatform}`, 'chrome');
  };

  const exists = async (file) => {
    try { return (await fs.stat(file)).isFile(); } catch { return false; }
  };

  const probe = async (file, env) => {
    if (!path.isAbsolute(file) || !await exists(file)) return false;
    if (options.probe) return options.probe(file, env);
    if (platform === 'win32') {
      // Windows Chrome can ignore --version and keep browser children alive.
      // Read the PE version resource without running or touching a profile.
      const script = `[Diagnostics.FileVersionInfo]::GetVersionInfo('${file.replaceAll("'", "''")}').ProductVersion`;
      const result = await run('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, timeout: 10000, capture: true });
      return !result.error && result.status === 0 && /^\d+(?:\.\d+){3}/.test(result.stdout.trim());
    }
    const result = await run(file, ['--version'], { env, timeout: 10000, capture: true });
    return !result.error && result.status === 0;
  };

  const allowedUrl = (value, kind) => {
    const url = new URL(value);
    if (options.fixtureOrigin && url.origin === options.fixtureOrigin && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return true;
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
    if (kind === 'metadata') return url.hostname === 'googlechromelabs.github.io' && url.pathname.startsWith('/chrome-for-testing/');
    return url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/chrome-for-testing-public/');
  };

  const request = async (url, kind) => {
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (!allowedUrl(current, kind)) throw new Error('Chrome for Testing returned a download location outside the official Google source.');
      const response = await fetcher(current, {
        headers: { 'User-Agent': 'Whisper-Studio-bootstrap' },
        credentials: 'omit', redirect: 'manual',
        signal: AbortSignal.timeout(options.downloadTimeoutMs ?? (kind === 'metadata' ? 30000 : 15 * 60 * 1000))
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('The Chrome download redirect has no location.');
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok) throw new Error(`Chrome download server returned HTTP ${response.status}.`);
      return response;
    }
    throw new Error('The Chrome download server returned too many redirects.');
  };

  const retry = async (operation, label) => {
    let failure;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { return await operation(attempt); }
      catch (error) {
        failure = error;
        if (attempt < attempts) { log(`${label}: retrying (${attempt + 1}/${attempts})...`); await retryWait(attempt * 500); }
      }
    }
    throw new Error(`${label} failed. Check your internet connection and run the launcher again.`, { cause: failure });
  };

  const metadata = () => retry(async () => {
    const response = await request(options.metadataUrl ?? METADATA_URL, 'metadata');
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('Chrome metadata is unexpectedly large.');
    return JSON.parse(text);
  }, 'Reading official Chrome for Testing release metadata');

  const download = async (url, destination, version) => retry(async () => {
    const partial = `${destination}.partial-${randomUUID()}`;
    try {
      log(`Downloading Chrome for Testing ${version} (${targetPlatform})...`);
      const response = await request(url, 'download');
      const length = Number(response.headers.get('content-length') || response.headers.get('x-goog-stored-content-length'));
      if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Google did not provide the Chrome archive size.');
      if (!response.body) throw new Error('Google returned an empty Chrome archive.');
      let received = 0;
      let reportedAt = Date.now();
      const progress = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length;
        if (Date.now() - reportedAt >= 2000) {
          log(`Chrome for Testing: ${Math.min(100, received / length * 100).toFixed(0)}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
          reportedAt = Date.now();
        }
        callback(null, chunk);
      } });
      // CfT's official JSON API does not publish SHA256 checksums. Do not claim
      // checksum validation: rely on authenticated Google TLS, complete length,
      // ZIP structure/path validation and an executable version probe instead.
      await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { flags: 'wx' }));
      if (received !== length) throw new Error('The Chrome archive download was incomplete.');
      await fs.rename(partial, destination);
      log('Chrome for Testing: complete archive downloaded from Google.');
    } finally { await fs.rm(partial, { force: true }); }
  }, 'Downloading Chrome for Testing');

  const systemCandidates = (env) => {
    if (options.systemCandidates) return options.systemCandidates;
    if (platform === 'win32') {
      return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean).flatMap((base) => [
        path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(base, 'Chromium', 'Application', 'chrome.exe')
      ]);
    }
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    return (env[pathKey] ?? '/usr/local/bin:/usr/bin:/bin').split(platform === 'win32' ? ';' : ':').filter(Boolean)
      .flatMap((base) => ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'].map((name) => path.resolve(base, name)));
  };

  const checkExtracted = async (directory, extractionRoot) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (!inside(extractionRoot, await fs.realpath(file))) throw new Error('The Chrome archive contains a link outside its directory.');
      } else if (entry.isDirectory()) await checkExtracted(file, extractionRoot);
    }
  };

  const rename = async (from, to) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await (options.rename || fs.rename)(from, to); }
      catch (error) {
        if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 7) throw error;
        await retryWait(250 * (attempt + 1));
      }
    }
  };
  const activate = async (unpacked, target) => {
    const backup = `${target}.backup-${randomUUID()}`;
    let movedOld = false;
    try {
      try { await rename(target, backup); movedOld = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(unpacked, target);
    } catch (error) {
      if (movedOld) await rename(backup, target);
      throw error;
    }
    if (movedOld) await fs.rm(backup, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  };

  const ensureChromiumBrowser = async (projectRoot, env = process.env) => {
    if (platform !== 'win32' && platform !== 'linux') {
      log(`This project supports Windows and Linux. Browser setup is unavailable on ${platform}.`);
      return null;
    }
    const configured = env.WHISPER_CHROMIUM_PATH?.trim();
    if (configured) {
      const browser = path.resolve(projectRoot, configured);
      if (!await probe(browser, env)) throw new Error('WHISPER_CHROMIUM_PATH does not point to a working Chrome, Edge or Chromium executable. Correct that setting and run the launcher again.');
      return browser;
    }
    const root = await fs.realpath(path.resolve(projectRoot));
    const runtime = path.join(root, '.runtime');
    await fs.mkdir(runtime, { recursive: true });
    if (!inside(root, await fs.realpath(runtime))) throw new Error('The .runtime directory points outside this project.');
    const target = path.join(runtime, 'chromium');
    try { if (!inside(runtime, await fs.realpath(target))) throw new Error('The Chromium runtime directory points outside this project.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const portableCandidates = [
      targetPlatform && path.join(target, relativeExecutable(targetPlatform)),
      path.join(target, platform === 'win32' ? 'chrome.exe' : 'chrome'),
      path.join(target, 'bin', platform === 'win32' ? 'chrome.exe' : 'chrome')
    ].filter(Boolean);
    for (const browser of portableCandidates) if (await probe(browser, env)) return browser;
    // A Windows file lock can delay activation after a complete, validated ZIP.
    // Retain and reuse that prepared package instead of downloading it again.
    for (const entry of await fs.readdir(runtime, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('chromium-download-')) continue;
      const work = path.join(runtime, entry.name);
      let prepared;
      try { prepared = JSON.parse(await fs.readFile(path.join(work, '.prepared.json'), 'utf8')); } catch { continue; }
      if (prepared.platform !== targetPlatform || !/^\d+(?:\.\d+){3}$/.test(prepared.version || '')) continue;
      const unpacked = path.join(work, 'ready');
      await checkExtracted(unpacked, unpacked);
      if (!await probe(path.join(unpacked, relativeExecutable(targetPlatform)), env)) continue;
      await activate(unpacked, target);
      await fs.rm(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      log(`Reused the prepared Chrome for Testing ${prepared.version} package.`);
      return path.join(target, relativeExecutable(targetPlatform));
    }
    if (env.WHISPER_PORTABLE_ONLY !== '1') {
      for (const browser of systemCandidates(env)) if (await probe(browser, env)) return browser;
    }
    if (!targetPlatform) {
      log(`No official Chrome for Testing package is available for ${platform}/${arch}. Douyin browser fallback is unavailable; core downloading and transcription remain usable.`);
      return null;
    }
    const release = (await metadata()).channels?.Stable;
    if (!/^\d+(?:\.\d+){3}$/.test(release?.version ?? '')) throw new Error('The official Chrome Stable release metadata has no valid version.');
    const asset = release.downloads?.chrome?.find((item) => item.platform === targetPlatform);
    if (!asset) {
      log(`Google has no Stable Chrome package for ${targetPlatform}. Douyin browser fallback is unavailable; core downloading and transcription remain usable.`);
      return null;
    }
    if (!allowedUrl(asset.url, 'download')) throw new Error('Chrome metadata points outside the official Google download source.');
    const work = await fs.mkdtemp(path.join(runtime, 'chromium-download-'));
    let prepared = false;
    let activated = false;
    try {
      const archive = path.join(work, 'chrome.zip');
      await download(asset.url, archive, release.version);
      const unpacked = path.join(work, 'ready');
      await extract(archive, unpacked, env);
      await checkExtracted(unpacked, unpacked);
      const browser = path.join(unpacked, relativeExecutable(targetPlatform));
      if (platform !== 'win32' && await exists(browser)) await fs.chmod(browser, 0o755);
      if (!await probe(browser, env)) throw new Error('The downloaded Chrome for Testing failed validation. The existing runtime was preserved. Linux may need system libraries for Chromium.');
      await fs.writeFile(path.join(work, '.prepared.json'), JSON.stringify({ platform: targetPlatform, version: release.version }));
      prepared = true;
      await activate(unpacked, target);
      activated = true;
      log(`Project-local Chrome for Testing ${release.version} is ready for isolated browser parsing.`);
      return path.join(target, relativeExecutable(targetPlatform));
    } finally {
      if (!prepared || activated) await fs.rm(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      else log('The validated Chrome package was preserved. Run the launcher again to finish activation.');
    }
  };

  return { ensureChromiumBrowser };
}

export const ensureChromiumBrowser = createBrowserRuntime().ensureChromiumBrowser;
