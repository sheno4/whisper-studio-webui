import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { transformSync } = createRequire(require.resolve('tsx'))('esbuild');
const source = fs.readFileSync(new URL('../src/renderer/web-api.ts', import.meta.url), 'utf8');
const code = transformSync(source.replace('import.meta.env.VITE_API_BASE', '""'), { loader: 'ts', format: 'cjs' }).code;

function loadTransport(fetch, query = '') {
  const clicked = [];
  const revoked = [];
  const events = [];
  class FakeEvents {
    constructor() { events.push(this); }
    addEventListener() {}
    close() {}
  }
  class FakeUrl extends URL {
    static createObjectURL() { return 'blob:audit-download'; }
    static revokeObjectURL(value) { revoked.push(value); }
  }
  const window = {
    location: { search: query, href: `http://127.0.0.1/${query}` },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    history: { replaceState: () => {} },
    setTimeout: (callback) => { callback(); }
  };
  const document = {
    body: { append() {} },
    createElement: () => ({ click() { clicked.push({ href: this.href, download: this.download }); }, remove() {} })
  };
  vm.runInNewContext(code, { window, document, fetch, Headers, URL: FakeUrl, URLSearchParams, File, crypto, console, EventSource: FakeEvents });
  return { api: window.whisperWeb, clicked, revoked, events };
}

test('mixed upload failures preserve successful paths and report failed filenames', async () => {
  const attempted = [];
  const { api } = loadTransport(async (url) => {
    attempted.push(url);
    return url.includes('unsupported.aiff')
      ? new Response(JSON.stringify({ error: 'Unsupported media extension: .aiff' }), { status: 415 })
      : Response.json({ path: url.includes('first.wav') ? 'first-path' : 'last-path' }, { status: 201 });
  });
  const toasts = [];
  const off = api.onToast((toast) => toasts.push(toast));
  const paths = await api.uploadFiles([
    new File(['audit'], 'first.wav'), new File(['audit'], 'unsupported.aiff'), new File(['audit'], 'last.wav')
  ]);
  assert.deepEqual(Array.from(paths), ['first-path', 'last-path']);
  assert.equal(attempted.length, 3);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /unsupported\.aiff/);
  off();
});

test('an entirely failed upload rejects with filenames and reasons', async () => {
  const { api } = loadTransport(async () => new Response(JSON.stringify({ error: 'disk full' }), { status: 500 }));
  await assert.rejects(api.uploadFiles([new File(['audit'], 'one.wav')]), /one\.wav.*disk full/);
});

test('export surfaces HTTP errors and never clicks a failed download', async () => {
  for (const status of [404, 500]) {
    const transport = loadTransport(async () => new Response(JSON.stringify({ error: 'file unavailable' }), { status }));
    await assert.rejects(transport.api.exportTaskFile('missing-task', 'transcriptTxt'), /file unavailable/);
    assert.equal(transport.clicked.length, 0);
  }
});

test('export downloads successful content with its UTF-8 filename and releases the URL', async () => {
  const transport = loadTransport(async () => new Response('字幕', {
    headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E5%AD%97%E5%B9%95.txt" }
  }));
  assert.equal(await transport.api.exportTaskFile('task', 'transcriptTxt'), true);
  assert.deepEqual(transport.clicked, [{ href: 'blob:audit-download', download: '字幕.txt' }]);
  assert.deepEqual(transport.revoked, ['blob:audit-download']);
});

test('a failed session can be retried and concurrent API calls share its new session', async () => {
  let sessions = 0;
  let snapshots = 0;
  const transport = loadTransport(async (url) => {
    if (url === '/api/session') {
      sessions++;
      if (sessions === 1) throw new Error('temporary network failure');
      return Response.json({ ok: true });
    }
    snapshots++;
    return Response.json({ tasks: [] });
  }, '?token=fake-audit-token');
  await assert.rejects(transport.api.getSnapshot(), /temporary network failure/);
  const off = transport.api.onState(() => {});
  await Promise.all([transport.api.getSnapshot(), transport.api.getSnapshot()]);
  assert.equal(sessions, 2);
  assert.equal(snapshots, 2);
  assert.equal(transport.events.length, 1);
  off();
});
