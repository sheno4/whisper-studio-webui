import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createPortableTools } from '../scripts/portable-tools.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const missing = { status: 1, stdout: '', stderr: '' };
const success = { status: 0, stdout: '', stderr: '' };
const pythonSuccess = (executable, version = [3, 14]) => ({ ...success, stdout: JSON.stringify({ executable, version }) });

const fixture = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-portable-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
};

const serverFixture = async (t, handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
};

const executableProbe = async (command) => {
  try { return (await fs.readFile(command, 'utf8')).startsWith('working') ? success : missing; }
  catch { return missing; }
};

test('an explicit invalid bootstrap interpreter fails without falling back or downloading', async (t) => {
  const root = await fixture(t);
  const calls = [];
  const tools = createPortableTools({
    run: async (command) => { calls.push(command); return missing; },
    fetch: async () => { throw new Error('Unexpected download'); }
  });
  await assert.rejects(tools.ensurePythonRuntime(root, { WHISPER_BOOTSTRAP_PYTHON: 'chosen-python' }), /WHISPER_BOOTSTRAP_PYTHON/);
  assert.deepEqual(calls, ['chosen-python']);
  assert.equal(await fs.stat(path.join(root, '.runtime')).catch(() => null), null);
});

test('a valid system interpreter uses its real executable and does not install uv', async (t) => {
  const root = await fixture(t);
  const tools = createPortableTools({
    platform: 'win32', arch: 'x64',
    run: async (command) => command === 'py' ? pythonSuccess('C:\\Python314\\python.exe') : missing,
    fetch: async () => { throw new Error('Unexpected download'); }
  });
  assert.deepEqual(await tools.ensurePythonRuntime(root, {}), { command: 'C:\\Python314\\python.exe', args: [] });
  assert.equal(await fs.stat(path.join(root, '.runtime', 'uv')).catch(() => null), null);
});

test('missing Python downloads verified uv and confines managed Python to this project', async (t) => {
  const root = await fixture(t);
  const archiveBytes = Buffer.from('small verified archive fixture');
  const asset = 'uv-x86_64-pc-windows-msvc.zip';
  const requests = [];
  const base = await serverFixture(t, (req, res) => {
    requests.push(req.url);
    res.end(req.url.endsWith('.sha256') ? `${digest(archiveBytes)}  ${asset}\n` : archiveBytes);
  });
  const calls = [];
  const pythonCommand = path.join(root, '.runtime', 'python', 'managed-3.14', 'python.exe');
  const tools = createPortableTools({
    platform: 'win32', arch: 'x64', uvReleaseBase: base, logger: () => {},
    extract: async (_archive, destination) => {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, 'uv.exe'), 'working uv');
    },
    run: async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (command === pythonCommand) return pythonSuccess(pythonCommand);
      if (!command.endsWith('uv.exe')) return missing;
      if (args[0] === '--version') return executableProbe(command);
      if (args[1] === 'install') {
        await fs.mkdir(path.dirname(pythonCommand), { recursive: true });
        await fs.writeFile(pythonCommand, 'working Python');
        return success;
      }
      if (args[1] === 'find') return { ...success, stdout: `${pythonCommand}\n` };
      return missing;
    }
  });
  assert.deepEqual(await tools.ensurePythonRuntime(root, {}), { command: pythonCommand, args: [] });
  const install = calls.find((call) => call.args[1] === 'install');
  assert.equal(install.env.UV_PYTHON_INSTALL_DIR, path.join(root, '.runtime', 'python'));
  assert.equal(install.env.UV_PYTHON_INSTALL_BIN, '0');
  assert.ok(install.args.includes('--no-registry'));
  assert.equal(await fs.readFile(path.join(root, '.runtime', 'uv', 'uv.exe'), 'utf8'), 'working uv');
  assert.deepEqual(requests, [`/${asset}.sha256`, `/${asset}`]);
});

test('both existing ffmpeg and ffprobe must work before setup is skipped', async (t) => {
  const root = await fixture(t);
  const bin = path.join(root, '.runtime', 'ffmpeg', 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'ffmpeg.exe'), 'working ffmpeg');
  await fs.writeFile(path.join(bin, 'ffprobe.exe'), 'working ffprobe');
  const tools = createPortableTools({ platform: 'win32', arch: 'x64', run: executableProbe, fetch: async () => { throw new Error('Unexpected download'); } });
  assert.deepEqual(await tools.ensureFfmpeg(root, {}), { ffmpeg: path.join(bin, 'ffmpeg.exe'), ffprobe: path.join(bin, 'ffprobe.exe'), binDir: bin });
});

test('a missing ffprobe triggers a verified install and transient download failures can recover', async (t) => {
  const root = await fixture(t);
  const oldBin = path.join(root, '.runtime', 'ffmpeg', 'bin');
  await fs.mkdir(oldBin, { recursive: true });
  await fs.writeFile(path.join(oldBin, 'ffmpeg'), 'working old ffmpeg');
  const bytes = { ffmpeg: gzipSync('working new ffmpeg'), ffprobe: gzipSync('working new ffprobe') };
  let failedOnce = false;
  const base = await serverFixture(t, (req, res) => {
    const name = req.url.slice(1);
    if (name === 'ffprobe' && !failedOnce) { failedOnce = true; res.writeHead(503); res.end(); return; }
    res.end(bytes[name]);
  });
  const messages = [];
  const tools = createPortableTools({
    platform: 'linux', arch: 'arm64', run: executableProbe, wait: async () => {}, logger: (message) => messages.push(message),
    ffmpegSources: Object.keys(bytes).map((name) => ({ kind: 'gzip', name, url: `${base}/${name}`, sha256: digest(bytes[name]) }))
  });
  const result = await tools.ensureFfmpeg(root, {});
  assert.equal(await fs.readFile(result.ffmpeg, 'utf8'), 'working new ffmpeg');
  assert.equal(await fs.readFile(result.ffprobe, 'utf8'), 'working new ffprobe');
  assert.ok(messages.some((message) => message.includes('retry 2/3')));
  assert.deepEqual((await fs.readdir(path.join(root, '.runtime'))).sort(), ['ffmpeg']);
});

test('checksum failure never replaces a partially usable existing FFmpeg installation', async (t) => {
  const root = await fixture(t);
  const bin = path.join(root, '.runtime', 'ffmpeg', 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'ffmpeg'), 'working original ffmpeg');
  const base = await serverFixture(t, (_req, res) => res.end(gzipSync('tampered content')));
  let extractionCalled = false;
  const tools = createPortableTools({
    platform: 'linux', arch: 'x64', logger: () => {}, run: executableProbe,
    extract: async () => { extractionCalled = true; },
    ffmpegSources: [{ kind: 'archive', url: `${base}/archive.tar.gz`, sha256: 'a'.repeat(64) }]
  });
  await assert.rejects(tools.ensureFfmpeg(root, {}), /SHA256 verification/);
  assert.equal(extractionCalled, false);
  assert.equal(await fs.readFile(path.join(bin, 'ffmpeg'), 'utf8'), 'working original ffmpeg');
  assert.deepEqual(await fs.readdir(path.join(root, '.runtime')), ['ffmpeg']);
});

test('downloaded binaries that cannot start fail setup and preserve the old files', async (t) => {
  const root = await fixture(t);
  const bin = path.join(root, '.runtime', 'ffmpeg', 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'ffmpeg'), 'working original ffmpeg');
  const bytes = { ffmpeg: gzipSync('working replacement'), ffprobe: gzipSync('broken downloaded binary') };
  const base = await serverFixture(t, (req, res) => res.end(bytes[req.url.slice(1)]));
  const tools = createPortableTools({
    platform: 'linux', arch: 'x64', logger: () => {}, run: executableProbe,
    ffmpegSources: Object.keys(bytes).map((name) => ({ kind: 'gzip', name, url: `${base}/${name}`, sha256: digest(bytes[name]) }))
  });
  await assert.rejects(tools.ensureFfmpeg(root, {}), /could not start/);
  assert.equal(await fs.readFile(path.join(bin, 'ffmpeg'), 'utf8'), 'working original ffmpeg');
});

test('runtime junctions outside the project are rejected before any download', async (t) => {
  const root = await fixture(t);
  const external = await fixture(t);
  await fs.symlink(external, path.join(root, '.runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  const tools = createPortableTools({ run: async () => missing, fetch: async () => { throw new Error('Unexpected download'); } });
  await assert.rejects(tools.ensureFfmpeg(root, {}), /outside this project/);
  assert.deepEqual(await fs.readdir(external), []);
});

test('portable-only Python skips a working system interpreter and keeps explicit overrides', async (t) => {
  const root = await fixture(t);
  const uv = path.join(root, '.runtime', 'uv', 'uv.exe');
  await fs.mkdir(path.dirname(uv), { recursive: true });
  await fs.writeFile(uv, 'working uv');
  const managed = path.join(root, '.runtime', 'python', 'managed', 'python.exe');
  const calls = [];
  const tools = createPortableTools({
    platform: 'win32', arch: 'x64', logger: () => {},
    fetch: async () => { throw new Error('Unexpected download'); },
    run: async (command, args) => {
      calls.push(command);
      if (command === 'chosen-python') return pythonSuccess('C:\\Chosen\\python.exe');
      if (command === managed) return pythonSuccess(managed);
      if (command === uv && args[1] === 'find') return { ...success, stdout: managed };
      if (command === uv) return success;
      throw new Error('A system interpreter should not be probed');
    }
  });
  assert.deepEqual(await tools.ensurePythonRuntime(root, { WHISPER_PORTABLE_ONLY: '1' }), { command: managed, args: [] });
  assert.ok(calls.every((command) => path.isAbsolute(command)));
  assert.deepEqual(await tools.ensurePythonRuntime(root, { WHISPER_PORTABLE_ONLY: '1', WHISPER_BOOTSTRAP_PYTHON: 'chosen-python' }), { command: 'C:\\Chosen\\python.exe', args: [] });
});

test('portable-only FFmpeg installs both project tools even when system commands would work', async (t) => {
  const root = await fixture(t);
  const bytes = { ffmpeg: gzipSync('working project ffmpeg'), ffprobe: gzipSync('working project ffprobe') };
  const base = await serverFixture(t, (req, res) => res.end(bytes[req.url.slice(1)]));
  const calls = [];
  const tools = createPortableTools({
    platform: 'linux', arch: 'arm64', logger: () => {},
    ffmpegSources: Object.keys(bytes).map((name) => ({ kind: 'gzip', name, url: `${base}/${name}`, sha256: digest(bytes[name]) })),
    run: async (command) => {
      calls.push(command);
      if (command === 'ffmpeg' || command === 'ffprobe') throw new Error('A system tool should not be probed');
      return executableProbe(command);
    }
  });
  const installed = await tools.ensureFfmpeg(root, { WHISPER_PORTABLE_ONLY: '1' });
  assert.equal(await fs.readFile(installed.ffprobe, 'utf8'), 'working project ffprobe');
  assert.ok(calls.every((command) => path.isAbsolute(command)));
});

function testPython(t) {
  const local = fileURLToPath(new URL(process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python', import.meta.url));
  const candidates = [process.env.WHISPER_PYTHON_PATH, local, process.platform === 'win32' ? 'python' : 'python3'].filter(Boolean);
  for (const command of candidates) {
    const result = spawnSync(command, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (!result.error && result.status === 0) return result.stdout.trim();
  }
  t.skip('A Python interpreter is needed for the real ZIP extraction fixture.');
  return null;
}

function writeZip(python, file, mode = 'valid') {
  const source = [
    'import stat, sys, zipfile',
    'archive, mode = sys.argv[1:3]',
    'with zipfile.ZipFile(archive, "w") as package:',
    ' entry = zipfile.ZipInfo("chrome-linux64/chrome")',
    ' entry.create_system = 3',
    ' entry.external_attr = (stat.S_IFREG | 0o755) << 16',
    ' package.writestr(entry, "browser fixture")',
    ' if mode == "traversal": package.writestr("../outside.txt", "refuse")',
    ' if mode == "symlink":',
    '  link = zipfile.ZipInfo("chrome-linux64/link")',
    '  link.create_system = 3',
    '  link.external_attr = (stat.S_IFLNK | 0o777) << 16',
    '  package.writestr(link, "../../outside.txt")'
  ].join('\n');
  const result = spawnSync(python, ['-c', source, file, mode], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
}

test('Linux ZIP uses the prepared Python and preserves executable permissions without GNU tar', async (t) => {
  const python = testPython(t);
  if (!python) return;
  const root = await fixture(t);
  const archive = path.join(root, 'chrome.zip');
  writeZip(python, archive);
  const destination = path.join(root, 'unpacked');
  const tools = createPortableTools({ platform: 'linux' });
  await tools.extractArchive(archive, destination, { ...process.env, WHISPER_PYTHON_PATH: python });
  const browser = path.join(destination, 'chrome-linux64', 'chrome');
  assert.equal(await fs.readFile(browser, 'utf8'), 'browser fixture');
  if (process.platform !== 'win32') assert.equal((await fs.stat(browser)).mode & 0o777, 0o755);
});

test('Linux ZIP validates every entry before writing and refuses archive symlinks', async (t) => {
  const python = testPython(t);
  if (!python) return;
  const root = await fixture(t);
  const tools = createPortableTools({ platform: 'linux' });
  for (const mode of ['traversal', 'symlink']) {
    const archive = path.join(root, `${mode}.zip`);
    writeZip(python, archive, mode);
    const destination = path.join(root, mode);
    await assert.rejects(tools.extractArchive(archive, destination, { ...process.env, WHISPER_PYTHON_PATH: python }), /ZIP extraction failed/);
    assert.deepEqual(await fs.readdir(destination), []);
  }
  assert.equal(await fs.stat(path.join(root, 'outside.txt')).catch(() => null), null);
});

test('Windows ZIP extraction repairs an inherited PowerShell module path', { skip: process.platform !== 'win32' }, async (t) => {
  const python = testPython(t);
  if (!python) return;
  const root = await fixture(t);
  const archive = path.join(root, 'chrome.zip');
  writeZip(python, archive);
  const destination = path.join(root, 'unpacked');
  const tools = createPortableTools({ platform: 'win32' });
  await tools.extractArchive(archive, destination, { ...process.env, PSModulePath: path.join(root, 'nonexistent-modules') });
  assert.equal(await fs.readFile(path.join(destination, 'chrome-linux64', 'chrome'), 'utf8'), 'browser fixture');
});

test('Windows activation retries locks and reuses the verified FFmpeg package after a failed launch', async (t) => {
  const root = await fixture(t);
  const oldBin = path.join(root, '.runtime', 'ffmpeg', 'bin');
  await fs.mkdir(oldBin, { recursive: true });
  await fs.writeFile(path.join(oldBin, 'ffmpeg.exe'), 'working old ffmpeg');
  const bytes = { ffmpeg: gzipSync('working replacement ffmpeg'), ffprobe: gzipSync('working replacement ffprobe') };
  const requests = [];
  const base = await serverFixture(t, (req, res) => { requests.push(req.url); res.end(bytes[req.url.slice(1)]); });
  let locked = true;
  let attempts = 0;
  const tools = createPortableTools({
    platform: 'win32', arch: 'x64', logger: () => {}, wait: async () => {}, run: executableProbe,
    ffmpegSources: Object.keys(bytes).map((name) => ({ kind: 'gzip', name, url: `${base}/${name}`, sha256: digest(bytes[name]) })),
    rename: async (source, destination) => {
      if (locked && source.includes('ffmpeg-download-') && destination === path.join(root, '.runtime', 'ffmpeg')) {
        attempts += 1;
        throw Object.assign(new Error('Simulated Windows antivirus file lock'), { code: 'EPERM' });
      }
      await fs.rename(source, destination);
    }
  });
  await assert.rejects(tools.ensureFfmpeg(root, { WHISPER_PORTABLE_ONLY: '1' }), /verified package remains/);
  assert.equal(attempts, 8);
  assert.equal(await fs.readFile(path.join(oldBin, 'ffmpeg.exe'), 'utf8'), 'working old ffmpeg');
  const cached = (await fs.readdir(path.join(root, '.runtime'))).filter((name) => name.startsWith('ffmpeg-download-'));
  assert.equal(cached.length, 1);
  const prepared = JSON.parse(await fs.readFile(path.join(root, '.runtime', cached[0], '.prepared.json'), 'utf8'));
  assert.equal(prepared.platform, 'win32');
  locked = false;
  const installed = await tools.ensureFfmpeg(root, { WHISPER_PORTABLE_ONLY: '1' });
  assert.equal(await fs.readFile(installed.ffprobe, 'utf8'), 'working replacement ffprobe');
  assert.deepEqual(requests.sort(), ['/ffmpeg', '/ffprobe']);
  assert.deepEqual(await fs.readdir(path.join(root, '.runtime')), ['ffmpeg']);
});

test('unsupported operating systems fail Python and FFmpeg setup before downloads or filesystem changes', async (t) => {
  const root = await fixture(t);
  const tools = createPortableTools({
    platform: 'darwin', arch: 'arm64',
    run: async () => { throw new Error('Unexpected runtime probe'); },
    fetch: async () => { throw new Error('Unexpected download'); }
  });
  await assert.rejects(tools.ensurePythonRuntime(root, { WHISPER_BOOTSTRAP_PYTHON: 'configured-python' }), /supports Windows and Linux/);
  await assert.rejects(tools.ensureFfmpeg(root, {}), /supports Windows and Linux/);
  assert.deepEqual(await fs.readdir(root), []);
});
