import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { translateSegmentsToChinese, TranslationError } from '../src/main/translation-client';

const source = [{ id: 1, start: 0, end: 1, text: 'hello' }];
const options = (baseUrl: string, requestLimit = 5, signal?: AbortSignal) => ({
  model: 'local-rate-audit', baseUrl, requestLimit, signal,
  customContent: '', enableAiContext: false, systemPrompt: '', multiplePrompt: '', prompt: '',
  maxTextLengthPerRequest: 100, maxTextGroupLengthPerRequest: 18,
  enableRichTranslate: false, maxTextGroupLengthPerRequestForSubtitle: 18,
  subtitlePrompt: '', temperature: 0.2,
  outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-translate-rate-')), outputBaseName: 'test'
});
const reply = (res: http.ServerResponse, chat = false) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(chat
    ? { id: 'mock', choices: [{ message: { content: '["译文"]' } }] }
    : { id: 'mock', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '["译文"]', annotations: [] }] }] }));
};
async function localServer(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
}

test('parallel tasks share endpoint and model request frequency without serializing HTTP', { timeout: 5000 }, async (t) => {
  const starts: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const baseUrl = await localServer(t, (req, res) => {
    req.resume();
    starts.push(performance.now());
    maximumActive = Math.max(maximumActive, ++active);
    setTimeout(() => { active--; reply(res); }, 600);
  });
  await Promise.all([baseUrl, `${baseUrl}/`, ` ${baseUrl}/ `].map(url =>
    translateSegmentsToChinese('', source, options(url))));
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 170, `first gap: ${starts[1] - starts[0]} ms`);
  assert.ok(starts[2] - starts[1] >= 170, `second gap: ${starts[2] - starts[1]} ms`);
  assert.ok(maximumActive >= 2, 'waiting for a start slot must not hold an HTTP concurrency lock');
});

test('cancelled queued tasks reject promptly and leave the next start slot available', { timeout: 5000 }, async (t) => {
  const starts: number[] = [];
  let firstArrived!: () => void;
  const arrived = new Promise<void>(resolve => { firstArrived = resolve; });
  const baseUrl = await localServer(t, (req, res) => {
    req.resume();
    starts.push(performance.now());
    firstArrived();
    reply(res);
  });
  const controller = new AbortController();
  const first = translateSegmentsToChinese('', source, options(baseUrl, 2));
  const cancelledOptions = options(baseUrl, 2, controller.signal);
  const cancelled = translateSegmentsToChinese('', source, cancelledOptions);
  const rejection = assert.rejects(cancelled, error => error instanceof TranslationError && error.code === 'cancelled');
  const next = translateSegmentsToChinese('', source, options(baseUrl, 2));
  await arrived;
  const abortAt = performance.now();
  controller.abort();
  await rejection;
  assert.ok(performance.now() - abortAt < 200, 'cancellation should interrupt the queue immediately');
  await Promise.all([first, next]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 350);
  assert.ok(starts[1] - starts[0] < 850, 'cancelled entries must not reserve a later start slot');
  assert.deepEqual(fs.readdirSync(cancelledOptions.outputDir), []);
});

test('retries and API compatibility fallback respect the same request-start limit', { timeout: 6000 }, async (t) => {
  const starts: number[] = [];
  const routes: string[] = [];
  const baseUrl = await localServer(t, (req, res) => {
    req.resume();
    starts.push(performance.now());
    routes.push(req.url ?? '');
    if (starts.length <= 2) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"local compatibility failure"}}');
    } else {
      reply(res, true);
    }
  });
  const result = await translateSegmentsToChinese('', source, options(baseUrl, 1));
  assert.equal(result.segments[0].text, '译文');
  assert.deepEqual(routes, ['/v1/responses', '/v1/responses', '/v1/chat/completions']);
  assert.ok(starts[1] - starts[0] >= 850, 'retry must acquire a start slot');
  assert.ok(starts[2] - starts[1] >= 850, 'compatibility fallback must acquire a start slot');
});

test('different models and nonpositive limits do not share a blocking start slot', { timeout: 5000 }, async (t) => {
  const responses: http.ServerResponse[] = [];
  const baseUrl = await localServer(t, (req, res) => {
    req.resume();
    responses.push(res);
    if (responses.length === 4) responses.forEach(response => reply(response));
  });
  await Promise.all([
    options(baseUrl, 0.1),
    { ...options(baseUrl, 0.1), model: 'other-local-model' },
    options(baseUrl, 0),
    options(baseUrl, -1)
  ].map(config => translateSegmentsToChinese('', source, config)));
  assert.equal(responses.length, 4);
});
