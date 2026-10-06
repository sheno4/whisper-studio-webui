import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

test('HTTP file routes and invalid requests return usable responses', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-http-routes-'));
  const previousData = process.env.WHISPER_DATA_DIR;
  const previousLimit = process.env.WHISPER_MAX_UPLOAD_MB;
  process.env.WHISPER_DATA_DIR = path.join(directory, '.data');
  process.env.WHISPER_MAX_UPLOAD_MB = '1';
  t.after(async () => {
    if (previousData === undefined) delete process.env.WHISPER_DATA_DIR;
    else process.env.WHISPER_DATA_DIR = previousData;
    if (previousLimit === undefined) delete process.env.WHISPER_MAX_UPLOAD_MB;
    else process.env.WHISPER_MAX_UPLOAD_MB = previousLimit;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { createWebServer } = await import('../src/server/http-server');
  const artifact = path.join(directory, '.outputs', '中文.txt');
  const bytes = Buffer.from('字幕测试', 'utf8');
  await fs.mkdir(path.dirname(artifact));
  await fs.writeFile(artifact, bytes);
  const manager = {
    getTaskFilePath: (id: string) => id === 'known' ? artifact : path.join(directory, 'missing.txt'),
    getSettings: () => ({ marker: 'authenticated' })
  } as unknown as Parameters<typeof createWebServer>[0];
  const server = createWebServer(manager, { host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    await t.test('downloads known artifacts inside a dot directory', async () => {
      const response = await fetch(`${base}/api/tasks/known/files/transcriptTxt`);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    });
    await t.test('wallpaper storage serves its bytes from the default .data directory', async () => {
      // Plain text fixture; no image decoding, screenshots, or recognition.
      const fixture = 'opaque HTTP storage fixture';
      const upload = await fetch(`${base}/api/wallpapers?name=fixture.png`, {
        method: 'POST', body: fixture, headers: { 'Content-Type': 'application/octet-stream' }
      });
      assert.equal(upload.status, 201);
      const result = await upload.json() as { path: string };
      const response = await fetch(base + result.path);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), fixture);
    });
    await t.test('missing artifacts return 404', async () => {
      const response = await fetch(`${base}/api/tasks/missing/files/transcriptTxt`);
      assert.equal(response.status, 404);
      await response.text();
    });
    await t.test('invalid or absent request bodies return 400', async () => {
      for (const route of ['/api/settings', '/api/tasks/links', '/api/tasks/files']) {
        const response = await fetch(base + route, { method: 'POST' });
        assert.equal(response.status, 400, route);
        assert.ok((await response.json() as { error: string }).error);
      }
      const response = await fetch(`${base}/api/settings`, {
        method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(response.status, 400);
      await response.text();
    });
    await t.test('oversized media returns 413 and cleans up the incomplete upload', async () => {
      const response = await fetch(`${base}/api/uploads?name=large.wav`, {
        method: 'POST', body: Buffer.alloc(1024 * 1024 + 1),
        headers: { 'Content-Type': 'application/octet-stream' }
      });
      assert.equal(response.status, 413);
      assert.match((await response.json() as { error: string }).error, /1 MB/);
      assert.deepEqual(await fs.readdir(path.join(directory, '.data', 'uploads')), []);
    });
    await t.test('long upload names retain their supported extension', async () => {
      const name = `${'a'.repeat(200)}.wav`;
      const response = await fetch(`${base}/api/uploads?name=${name}`, {
        method: 'POST', body: 'audio byte fixture', headers: { 'Content-Type': 'application/octet-stream' }
      });
      assert.equal(response.status, 201);
      const result = await response.json() as { name: string; path: string };
      assert.equal(result.name.length, 180);
      assert.equal(path.extname(result.path), '.wav');
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
