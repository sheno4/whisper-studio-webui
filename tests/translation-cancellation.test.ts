import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { translateSegmentsToChinese, TranslationError } from '../src/main/translation-client';

const fixture = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `whisper-translate-${name}-`));
const options = (outputDir: string, baseUrl: string, signal?: AbortSignal) => ({
  model: 'local-audit', baseUrl, signal, customContent: '', enableAiContext: false,
  systemPrompt: '', multiplePrompt: '', prompt: '', requestLimit: 100,
  maxTextLengthPerRequest: 100, maxTextGroupLengthPerRequest: 18,
  enableRichTranslate: false, maxTextGroupLengthPerRequestForSubtitle: 18,
  subtitlePrompt: '', temperature: 0.2, outputDir, outputBaseName: 'test'
});
const source = [{ id: 42, start: 1, end: 2, text: 'hello' }];
const cancelled = (error: unknown) => error instanceof TranslationError && error.code === 'cancelled';
const reply = (res: http.ServerResponse, texts: string[]) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: 'mock', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(texts), annotations: [] }] }] }));
};

async function localServer(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}

test('cancelling an in-flight HTTP request rejects promptly and writes no artifacts', { timeout: 5000 }, async (t) => {
  const root = fixture('http');
  const controller = new AbortController();
  let requests = 0;
  let requestArrived!: () => void;
  const arrived = new Promise<void>(resolve => { requestArrived = resolve; });
  const baseUrl = await localServer(t, (req) => { requests++; req.resume(); requestArrived(); });
  const pending = translateSegmentsToChinese('hello', source, options(root, baseUrl, controller.signal));
  const rejection = assert.rejects(pending, cancelled);
  await arrived;
  controller.abort();
  await rejection;
  assert.equal(requests, 1);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('cancellation interrupts retry and batch-rate waits without another request', { timeout: 5000 }, async (t) => {
  for (const mode of ['retry', 'rate'] as const) {
    await t.test(mode, async (subtest) => {
      const root = fixture(mode);
      const controller = new AbortController();
      let requests = 0;
      const baseUrl = await localServer(subtest, (req, res) => {
        requests++;
        req.resume();
        if (mode === 'retry') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"mock failure"}}'); }
        else reply(res, ['译文']);
      });
      const config = { ...options(root, baseUrl, controller.signal), requestLimit: 0.1, maxTextGroupLengthPerRequest: 1,
        onLog: (message: string) => { if (mode === 'retry' && message.includes('重试中')) setTimeout(() => controller.abort(), 20); },
        onProgress: (current: number) => { if (mode === 'rate' && current === 1) setTimeout(() => controller.abort(), 20); }
      };
      await assert.rejects(translateSegmentsToChinese('hello', mode === 'rate' ? [...source, { ...source[0], id: 43 }] : source, config), cancelled);
      assert.equal(requests, 1);
      assert.deepEqual(fs.readdirSync(root), []);
    });
  }
});

test('cancelling after the last response prevents writing translation artifacts', async (t) => {
  const root = fixture('final');
  const controller = new AbortController();
  const baseUrl = await localServer(t, (req, res) => { req.resume(); reply(res, ['译文']); });
  await assert.rejects(translateSegmentsToChinese('hello', source, { ...options(root, baseUrl, controller.signal), onProgress: (current, total) => { if (current === total) controller.abort(); } }), cancelled);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('long Unicode segments respect request length and reassemble with original IDs and timestamps', async (t) => {
  const root = fixture('length');
  const lengths: number[] = [];
  const baseUrl = await localServer(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const texts = JSON.parse(body.input.slice(body.input.indexOf('[\n'))) as string[];
      lengths.push(texts.reduce((sum, text) => sum + Array.from(text).length, 0));
      assert.equal(texts.some(text => !text.isWellFormed()), false);
      reply(res, texts);
    });
  });
  const segments = [{ id: 7, start: 1.25, end: 6.5, text: '😀中'.repeat(140) }, { id: 8, start: 7, end: 8, text: '后一段' }];
  const result = await translateSegmentsToChinese('', segments, options(root, baseUrl));
  assert.equal(lengths.length > 1, true);
  assert.equal(lengths.every(length => length <= 100), true);
  assert.deepEqual(result.segments, segments);
  assert.equal(Object.keys(result.outputFiles).length, 4);
});

test('task manager does not mark a cancelled final translation batch completed', { timeout: 5000 }, async (t) => {
  const root = fixture('manager');
  process.env.WHISPER_DATA_DIR = path.join(root, 'data');
  process.env.WHISPER_OUTPUT_DIR = path.join(root, 'outputs');
  const { TaskManager } = await import('../src/main/task-manager');
  const manager = new TaskManager() as any;
  let task: any;
  let cancelAccepted = false;
  const baseUrl = await localServer(t, (req, res) => {
    req.resume();
    void manager.cancelTask(task.id).then((accepted: boolean) => { cancelAccepted = accepted; reply(res, ['译文']); });
  });
  manager.settings.translationServices = [{ ...options(root, baseUrl), id: 'local', name: 'Local', enabled: true, apiUrl: baseUrl }];
  manager.settings.activeTranslationServiceId = 'local';
  manager.runWorkerTask = async (_task: unknown, request: any) => ({ outputDir: request.outputDir, displayName: 'cancel-test', outputFiles: {}, transcriptText: 'hello', transcriptSegments: source });
  task = manager.createTaskRecord('cancel-test.wav', 'file', { translateToChinese: true });
  manager.tasks.push(task);
  await manager.processQueue();
  assert.equal(cancelAccepted, true);
  assert.equal(task.status, 'cancelled');
  assert.equal(task.translationText, undefined);
  assert.equal(task.outputFiles.translationTxt, undefined);
  assert.equal(fs.readdirSync(task.outputDir).some(name => name.includes('.zh.')), false);
});
