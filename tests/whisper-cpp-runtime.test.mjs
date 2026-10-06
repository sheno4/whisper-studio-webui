import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWhisperCppRuntime, whisperCppAsset, WHISPER_CPP_VERSION, WHISPER_CPP_RELEASE_TAG } from '../scripts/whisper-cpp-runtime.mjs';

const bytes = Buffer.from('verified native runtime fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const success = { status: 0, stdout: '', stderr: 'CLI help may be written to stderr.' };
const missing = { status: 1, stdout: '', stderr: '' };
const fixture = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-native-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return fs.realpath(root);
};
const source = (asset) => ({ ...asset, url: 'https://runtime.example/native.zip', sha256, token: '', release: WHISPER_CPP_RELEASE_TAG });
const probe = async (command) => {
  try { return (await fs.readFile(command, 'utf8')).startsWith('working') ? success : missing; }
  catch { return missing; }
};
const bundle = async (_archive, destination, variant = 'vulkan', valid = true, platform = 'win32') => {
  const bin = path.join(destination, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'), valid ? 'working packaged CLI' : 'broken packaged CLI');
  if (variant !== 'cpu') await fs.writeFile(path.join(bin, platform === 'win32' ? `ggml-${variant}.dll` : `libggml-${variant}.so`), 'backend fixture');
};
const existing = async (root, variant, version = WHISPER_CPP_VERSION) => {
  const target = path.join(root, '.runtime', 'whisper-cpp');
  await bundle(null, target, variant);
  await fs.writeFile(path.join(target, 'bin', 'whisper-cli.exe'), 'working original CLI');
  await fs.writeFile(path.join(target, 'runtime.json'), JSON.stringify({ version, variant, platform: 'win32', arch: 'x64' }));
  return target;
};
const runtime = (options = {}) => createWhisperCppRuntime({
  platform: 'win32', arch: 'x64', logger: () => {}, wait: async () => {}, run: probe,
  source: async (asset) => source(asset), fetch: async () => new Response(bytes), extract: (archive, destination) => bundle(archive, destination),
  ...options
});

test('native asset selection covers the supported architectures and reports unsupported platforms', () => {
  for (const [platform, arch, variant] of [
    ['win32', 'x64', 'vulkan'], ['win32', 'arm64', 'cpu'],
    ['linux', 'x64', 'vulkan'], ['linux', 'arm64', 'vulkan']
  ]) {
    const asset = whisperCppAsset(platform, arch);
    assert.equal(asset.variant, variant);
    assert.match(asset.filename, new RegExp(`${arch}-${variant}[.](zip|tar[.]gz)$`));
  }
  assert.throws(() => whisperCppAsset('freebsd', 'x64'), /WHISPER_CPP_PATH/);
  assert.throws(() => whisperCppAsset('darwin', 'arm64'), /WHISPER_CPP_PATH/);
  assert.throws(() => whisperCppAsset('linux', 'ia32'), /WHISPER_CPP_PATH/);
});

test('explicit CLI configuration is checked before platform downloads or runtime writes', async (t) => {
  const root = await fixture(t);
  const custom = path.join(root, 'custom-cli.exe');
  await fs.writeFile(custom, 'working custom CLI');
  const tools = runtime({ fetch: async () => { throw new Error('Unexpected download'); } });
  assert.deepEqual(await tools.ensureWhisperCpp(root, { WHISPER_CPP_PATH: custom }), { executable: custom, variant: 'custom' });
  await assert.rejects(tools.ensureWhisperCpp(root, { WHISPER_CPP_PATH: `${custom}-missing` }), /WHISPER_CPP_PATH/);
  assert.equal(await fs.stat(path.join(root, '.runtime')).catch(() => null), null);
});

test('verified GPU installation records its platform and a valid repeat launch uses the cache', async (t) => {
  const root = await fixture(t);
  let downloads = 0;
  let sources = 0;
  const tools = runtime({
    source: async (asset) => { sources += 1; return { ...source(asset), token: 'fixture-private-token' }; },
    fetch: async () => { downloads += 1; return new Response(bytes); }
  });
  const installed = await tools.ensureWhisperCpp(root, {});
  assert.equal(installed.variant, 'vulkan');
  assert.equal(await fs.readFile(installed.executable, 'utf8'), 'working packaged CLI');
  const manifestText = await fs.readFile(path.join(root, '.runtime', 'whisper-cpp', 'runtime.json'), 'utf8');
  assert.deepEqual(JSON.parse(manifestText), {
    version: WHISPER_CPP_VERSION, release: WHISPER_CPP_RELEASE_TAG,
    variant: 'vulkan', targetVariant: 'vulkan', platform: 'win32', arch: 'x64'
  });
  assert.ok(!manifestText.includes('fixture-private-token'));
  assert.deepEqual(await tools.ensureWhisperCpp(root, {}), installed);
  assert.equal(downloads, 1);
  assert.equal(sources, 1);
  assert.deepEqual(await fs.readdir(path.join(root, '.runtime')), ['whisper-cpp']);
});

test('checksum failure preserves the previous runtime and never extracts unverified bytes', async (t) => {
  const root = await fixture(t);
  const target = await existing(root, 'vulkan', '1.9.3');
  let extracted = false;
  const tools = runtime({ fetch: async () => new Response('corrupted archive'), extract: async () => { extracted = true; } });
  await assert.rejects(tools.ensureWhisperCpp(root, {}), /SHA256 verification/);
  assert.equal(extracted, false);
  assert.equal(await fs.readFile(path.join(target, 'bin', 'whisper-cli.exe'), 'utf8'), 'working original CLI');
  assert.deepEqual(await fs.readdir(path.join(root, '.runtime')), ['whisper-cpp']);
});

test('a downloaded CLI that cannot start never replaces the old files', async (t) => {
  const root = await fixture(t);
  const target = await existing(root, 'vulkan', '1.9.3');
  const tools = runtime({ extract: (archive, destination) => bundle(archive, destination, 'vulkan', false) });
  await assert.rejects(tools.ensureWhisperCpp(root, {}), /cannot start/);
  assert.equal(await fs.readFile(path.join(target, 'bin', 'whisper-cli.exe'), 'utf8'), 'working original CLI');
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'runtime.json'), 'utf8')).version, '1.9.3');
  assert.deepEqual(await fs.readdir(path.join(root, '.runtime')), ['whisper-cpp']);
});

test('a CPU fallback is retained during an outage and upgraded when the GPU release becomes accessible', async (t) => {
  const root = await fixture(t);
  await existing(root, 'cpu');
  let available = false;
  let sourceRequests = 0;
  let downloads = 0;
  const tools = runtime({
    source: async (asset) => {
      sourceRequests += 1;
      if (!available) throw Object.assign(new Error('Release not published yet'), { code: 'RUNTIME_NOT_PUBLISHED' });
      return source(asset);
    },
    fetch: async () => { downloads += 1; return new Response(bytes); }
  });
  assert.equal((await tools.ensureWhisperCpp(root, {})).variant, 'cpu');
  assert.equal(downloads, 0);
  available = true;
  assert.equal((await tools.ensureWhisperCpp(root, {})).variant, 'vulkan');
  assert.equal(sourceRequests, 2);
  assert.equal(downloads, 1);
});

test('public releases use anonymous download URLs without credentials or the GitHub API', async (t) => {
  const root = await fixture(t);
  const asset = whisperCppAsset('win32', 'x64');
  const releaseBase = `https://github.com/sheno4/whisper-studio-webui/releases/download/${WHISPER_CPP_RELEASE_TAG}`;
  const calls = [];
  const tools = runtime({
    source: undefined,
    run: async (command) => {
      assert.ok(!['gh', 'git'].includes(command), 'Public downloads must not inspect GitHub credentials');
      return probe(command);
    },
    fetch: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      assert.notEqual(new URL(url).hostname, 'api.github.com');
      if (url === `${releaseBase}/SHA256SUMS`) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/checksums' } });
      if (url.endsWith('/checksums')) return new Response(`${sha256}  ${asset.filename}\n`);
      if (url === `${releaseBase}/${asset.filename}`) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/runtime' } });
      if (url.endsWith('/runtime')) return new Response(bytes);
      throw new Error('Unexpected fixture URL');
    }
  });
  assert.equal((await tools.ensureWhisperCpp(root, { WHISPER_GITHUB_TOKEN: 'unused-private-token' })).variant, 'vulkan');
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.authorization === undefined));
});

test('invalid public checksums never trigger a private API or credential fallback', async (t) => {
  const root = await fixture(t);
  await existing(root, 'cpu');
  const calls = [];
  const tools = runtime({
    source: undefined,
    run: async (command) => {
      assert.ok(!['gh', 'git'].includes(command), 'Invalid metadata must not trigger credential discovery');
      return probe(command);
    },
    fetch: async (url) => {
      calls.push(url);
      assert.ok(url.endsWith('/SHA256SUMS'));
      return new Response('invalid publisher metadata');
    }
  });
  assert.equal((await tools.ensureWhisperCpp(root, {})).variant, 'cpu');
  assert.equal(calls.length, 1);
});

test('GitHub authentication stays on GitHub when private release assets redirect to signed storage', async (t) => {
  const root = await fixture(t);
  const asset = whisperCppAsset('win32', 'x64');
  const secret = 'fixture-token-kept-in-memory';
  const calls = [];
  const messages = [];
  const tools = runtime({
    source: undefined,
    logger: (message) => messages.push(message),
    fetch: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      if (url.endsWith('/SHA256SUMS')) return new Response(null, { status: 404 });
      if (url.includes('/releases/tags/')) return Response.json({ assets: [
        { name: asset.filename, url: 'https://api.github.com/repos/example/native/releases/assets/1' },
        { name: 'SHA256SUMS', url: 'https://api.github.com/repos/example/native/releases/assets/2' }
      ] });
      if (url.endsWith('/assets/2')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/checksums' } });
      if (url.endsWith('/checksums')) return new Response(`${sha256}  ${asset.filename}\n`);
      if (url.endsWith('/assets/1')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/runtime' } });
      if (url.endsWith('/runtime')) return new Response(bytes);
      throw new Error('Unexpected fixture URL');
    }
  });
  assert.equal((await tools.ensureWhisperCpp(root, { WHISPER_GITHUB_TOKEN: secret })).variant, 'vulkan');
  for (const call of calls) {
    assert.equal(call.authorization, new URL(call.url).hostname === 'api.github.com' ? `Bearer ${secret}` : undefined);
  }
  assert.ok(!messages.join('\n').includes(secret));
  assert.ok(!JSON.stringify(JSON.parse(await fs.readFile(path.join(root, '.runtime', 'whisper-cpp', 'runtime.json'), 'utf8'))).includes(secret));
});

test('Linux runtime selection rejects musl and old glibc and uses CPU on older ARM64 glibc', async (t) => {
  const root = await fixture(t);
  for (const glibcVersion of ['2.34', 'musl']) {
    const tools = runtime({ platform: 'linux', arch: 'arm64', glibcVersion, fetch: async () => { throw new Error('Unexpected download'); } });
    await assert.rejects(tools.ensureWhisperCpp(root, {}), /glibc 2.35/);
  }
  let selected;
  const tools = runtime({
    platform: 'linux', arch: 'arm64', glibcVersion: '2.38',
    source: async (asset) => { selected = asset.variant; return source(asset); },
    extract: (archive, destination) => bundle(archive, destination, 'cpu', true, 'linux')
  });
  assert.equal((await tools.ensureWhisperCpp(root, {})).variant, 'cpu');
  assert.equal(selected, 'cpu');
});

test('archive paths cannot escape the staging directory before extraction', async (t) => {
  const root = await fixture(t);
  const calls = [];
  const tools = runtime({
    extract: undefined,
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === 'tar' && args[0] === '-tf') return { ...success, stdout: 'bin/whisper-cli.exe\n../outside-file\n' };
      return probe(command);
    }
  });
  await assert.rejects(tools.ensureWhisperCpp(root, {}), /unsafe path/);
  assert.equal(calls.some((call) => call.command === 'tar' && call.args[0] === '-xf'), false);
  assert.deepEqual(await fs.readdir(path.join(root, '.runtime')), []);
});
