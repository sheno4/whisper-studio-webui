import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserRuntime } from '../scripts/browser-runtime.mjs';

const version = '154.0.8037.92';
const missing = { status: 1, stdout: '', stderr: '' };
const fixture = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-browser-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
};
const serverFixture = async (t, handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
};
const workingBrowser = async (command) => {
  try { return (await fs.readFile(command, 'utf8')) === 'working browser' ? { status: 0, stdout: `Chrome ${version}`, stderr: '' } : missing; }
  catch { return missing; }
};
const installFixture = async (destination, packagePlatform = 'win64', content = 'working browser') => {
  const browser = path.join(destination, `chrome-${packagePlatform}`, packagePlatform.startsWith('win') ? 'chrome.exe' : 'chrome');
  await fs.mkdir(path.dirname(browser), { recursive: true });
  await fs.writeFile(browser, content);
};

test('an invalid explicit browser path is actionable and does not fall back', async (t) => {
  const root = await fixture(t);
  const tools = createBrowserRuntime({ fetch: async () => { throw new Error('Unexpected download'); } });
  await assert.rejects(tools.ensureChromiumBrowser(root, { WHISPER_CHROMIUM_PATH: 'missing-chrome.exe' }), /WHISPER_CHROMIUM_PATH/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('Windows browser detection reads PE metadata without starting Chrome or touching profiles', async (t) => {
  const root = await fixture(t);
  const installed = path.join(root, 'chrome.exe');
  await fs.writeFile(installed, 'working browser');
  let probeArgs;
  const tools = createBrowserRuntime({
    platform: 'win32', arch: 'x64', systemCandidates: [installed],
    fetch: async () => { throw new Error('Unexpected download'); },
    run: async (command, args) => {
      assert.equal(command, 'powershell.exe');
      probeArgs = args;
      return { status: 0, stdout: version, stderr: '' };
    }
  });
  assert.equal(await tools.ensureChromiumBrowser(root, {}), installed);
  assert.ok(probeArgs.includes('-EncodedCommand'));
  const script = Buffer.from(probeArgs.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('FileVersionInfo'));
  assert.ok(script.includes(installed));
});

test('a prepared Windows package survives file locking and finishes without another download', async (t) => {
  const root = await fixture(t);
  const work = path.join(root, '.runtime', 'chromium-download-fixture');
  await installFixture(path.join(work, 'ready'));
  await fs.writeFile(path.join(work, '.prepared.json'), JSON.stringify({ platform: 'win64', version }));
  let locked = true;
  let attempts = 0;
  const tools = createBrowserRuntime({
    platform: 'win32', arch: 'x64', probe: async (file) => (await workingBrowser(file)).status === 0,
    fetch: async () => { throw new Error('Prepared packages must not download again'); },
    logger: () => {}, wait: async () => {},
    rename: async (from, to) => {
      if (locked && from.endsWith('ready')) { attempts += 1; throw Object.assign(new Error('Windows lock'), { code: 'EPERM' }); }
      return fs.rename(from, to);
    }
  });
  await assert.rejects(tools.ensureChromiumBrowser(root, { WHISPER_PORTABLE_ONLY: '1' }), /Windows lock/);
  assert.equal(attempts, 8);
  assert.ok(await fs.stat(path.join(work, '.prepared.json')));
  locked = false;
  assert.equal(await tools.ensureChromiumBrowser(root, { WHISPER_PORTABLE_ONLY: '1' }), path.join(root, '.runtime', 'chromium', 'chrome-win64', 'chrome.exe'));
});

test('portable-only startup downloads and atomically installs the official platform package', async (t) => {
  const root = await fixture(t);
  const archive = Buffer.from('small browser archive fixture');
  const requests = [];
  let origin;
  origin = await serverFixture(t, (req, res) => {
    requests.push(req.url);
    if (req.url === '/metadata.json') {
      res.end(JSON.stringify({ channels: { Stable: { version, downloads: { chrome: [{ platform: 'win64', url: `${origin}/chrome.zip` }] } } } }));
    } else { res.setHeader('Content-Length', archive.length); res.end(archive); }
  });
  const installed = path.join(root, 'system-chrome.exe');
  await fs.writeFile(installed, 'working browser');
  const tools = createBrowserRuntime({
    platform: 'win32', arch: 'x64', metadataUrl: `${origin}/metadata.json`, fixtureOrigin: origin,
    systemCandidates: [installed], logger: () => {}, run: workingBrowser, probe: async (file) => (await workingBrowser(file)).status === 0,
    extract: async (file, destination) => {
      assert.deepEqual(await fs.readFile(file), archive);
      await installFixture(destination);
    }
  });
  const browser = await tools.ensureChromiumBrowser(root, { WHISPER_PORTABLE_ONLY: '1' });
  assert.equal(browser, path.join(root, '.runtime', 'chromium', 'chrome-win64', 'chrome.exe'));
  assert.equal(await fs.readFile(browser, 'utf8'), 'working browser');
  assert.deepEqual(requests, ['/metadata.json', '/chrome.zip']);
  assert.deepEqual(await fs.readdir(path.join(root, '.runtime')), ['chromium']);
});

test('an incomplete browser archive fails before extraction and preserves the old runtime', async (t) => {
  const root = await fixture(t);
  await installFixture(path.join(root, '.runtime', 'chromium'), 'win64', 'old broken browser');
  let origin;
  origin = await serverFixture(t, (req, res) => {
    if (req.url === '/metadata.json') {
      res.end(JSON.stringify({ channels: { Stable: { version, downloads: { chrome: [{ platform: 'win64', url: `${origin}/chrome.zip` }] } } } }));
    } else { res.setHeader('Content-Length', 100); res.setHeader('Connection', 'close'); res.end('short'); }
  });
  let extracted = false;
  const tools = createBrowserRuntime({
    platform: 'win32', arch: 'x64', metadataUrl: `${origin}/metadata.json`, fixtureOrigin: origin,
    systemCandidates: [], retryCount: 1, logger: () => {}, run: workingBrowser, probe: async (file) => (await workingBrowser(file)).status === 0,
    extract: async () => { extracted = true; }
  });
  await assert.rejects(tools.ensureChromiumBrowser(root, {}), /Downloading Chrome for Testing failed/);
  assert.equal(extracted, false);
  assert.equal(await fs.readFile(path.join(root, '.runtime', 'chromium', 'chrome-win64', 'chrome.exe'), 'utf8'), 'old broken browser');
  assert.deepEqual(await fs.readdir(path.join(root, '.runtime')), ['chromium']);
});

test('a Chrome metadata URL outside Google is rejected before fetching it', async (t) => {
  const root = await fixture(t);
  const requests = [];
  const origin = await serverFixture(t, (req, res) => {
    requests.push(req.url);
    res.end(JSON.stringify({ channels: { Stable: { version, downloads: { chrome: [{ platform: 'win64', url: 'https://third-party.example/chrome.zip' }] } } } }));
  });
  const tools = createBrowserRuntime({ platform: 'win32', arch: 'x64', metadataUrl: `${origin}/metadata.json`, fixtureOrigin: origin, systemCandidates: [], run: workingBrowser, probe: async (file) => (await workingBrowser(file)).status === 0 });
  await assert.rejects(tools.ensureChromiumBrowser(root, {}), /outside the official Google/);
  assert.deepEqual(requests, ['/metadata.json']);
});

test('a downloaded browser that cannot execute never replaces the previous files', async (t) => {
  const root = await fixture(t);
  await installFixture(path.join(root, '.runtime', 'chromium'), 'win64', 'original browser files');
  let origin;
  origin = await serverFixture(t, (req, res) => {
    if (req.url === '/metadata.json') {
      res.end(JSON.stringify({ channels: { Stable: { version, downloads: { chrome: [{ platform: 'win64', url: `${origin}/chrome.zip` }] } } } }));
    } else res.end('archive');
  });
  const tools = createBrowserRuntime({
    platform: 'win32', arch: 'x64', metadataUrl: `${origin}/metadata.json`, fixtureOrigin: origin,
    systemCandidates: [], logger: () => {}, run: workingBrowser, probe: async (file) => (await workingBrowser(file)).status === 0,
    extract: async (_file, destination) => installFixture(destination, 'win64', 'broken new browser')
  });
  await assert.rejects(tools.ensureChromiumBrowser(root, {}), /failed validation/);
  assert.equal(await fs.readFile(path.join(root, '.runtime', 'chromium', 'chrome-win64', 'chrome.exe'), 'utf8'), 'original browser files');
});

test('missing Linux ARM Stable packages clearly leave browser fallback unavailable', async (t) => {
  const root = await fixture(t);
  const messages = [];
  const origin = await serverFixture(t, (_req, res) => {
    res.end(JSON.stringify({ channels: { Stable: { version, downloads: { chrome: [] } } } }));
  });
  const tools = createBrowserRuntime({
    platform: 'linux', arch: 'arm64', metadataUrl: `${origin}/metadata.json`, fixtureOrigin: origin,
    systemCandidates: [], run: workingBrowser, probe: async (file) => (await workingBrowser(file)).status === 0, logger: (message) => messages.push(message)
  });
  assert.equal(await tools.ensureChromiumBrowser(root, {}), null);
  assert.ok(messages.some((message) => message.includes('linux-arm64') && message.includes('core downloading and transcription remain usable')));
});

test('tar path traversal is rejected by the shared extractor before extraction', async () => {
  const { createPortableTools } = await import('../scripts/portable-tools.mjs');
  const calls = [];
  const tools = createPortableTools({
    platform: 'linux',
    run: async (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '../outside/chrome\n', stderr: '' };
    }
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-archive-'));
  try {
    await assert.rejects(tools.extractArchive(path.join(root, 'ffmpeg.tar.xz'), path.join(root, 'unpacked'), {}), /unsafe path/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], '-tf');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Linux ARM Stable metadata selects the native Linux ARM archive', async (t) => {
  const root = await fixture(t);
  let origin;
  origin = await serverFixture(t, (req, res) => {
    if (req.url === '/metadata.json') {
      res.end(JSON.stringify({ channels: { Stable: { version, downloads: { chrome: [
        { platform: 'linux64', url: `${origin}/wrong.zip` },
        { platform: 'linux-arm64', url: `${origin}/arm.zip` }
      ] } } } }));
    } else {
      assert.equal(req.url, '/arm.zip');
      res.end('archive');
    }
  });
  const tools = createBrowserRuntime({
    platform: 'linux', arch: 'arm64', metadataUrl: `${origin}/metadata.json`, fixtureOrigin: origin,
    systemCandidates: [], run: workingBrowser, probe: async (file) => (await workingBrowser(file)).status === 0, logger: () => {},
    extract: async (_archive, destination) => installFixture(destination, 'linux-arm64')
  });
  assert.equal(await tools.ensureChromiumBrowser(root, {}), path.join(root, '.runtime', 'chromium', 'chrome-linux-arm64', 'chrome'));
});

test('unsupported platform browser setup returns before filesystem changes or browser probes', async (t) => {
  const root = await fixture(t);
  const messages = [];
  const tools = createBrowserRuntime({
    platform: 'darwin', arch: 'arm64', logger: (message) => messages.push(message),
    fetch: async () => { throw new Error('Unexpected download'); },
    run: async () => { throw new Error('Unexpected browser probe'); }
  });
  assert.equal(await tools.ensureChromiumBrowser(root, { WHISPER_CHROMIUM_PATH: 'configured-browser' }), null);
  assert.deepEqual(await fs.readdir(root), []);
  assert.ok(messages.some((message) => message.includes('supports Windows and Linux')));
});
