import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { HistoryRecord, TaskRecord } from '../src/shared/types';

const taskFixture = (id: string): TaskRecord => ({
  id, sourceType: 'link', input: 'https://example.invalid/media', displayName: '完整结果 😀', status: 'completed',
  progressPercent: 100, progressMessage: '转写和翻译已完成',
  createdAt: '2026-10-19T01:00:00.000Z', updatedAt: '2026-10-19T01:01:00.000Z', attempts: 1,
  translateToChinese: true, downloadBehavior: 'transcribe', videoQuality: 'best', transcriptionLanguage: 'auto',
  language: 'en', transcriptText: 'Original words.\nSecond line.', translationText: '原始译文。\n第二行。',
  transcriptSegments: [{ id: 0, start: 0.5, end: 2.75, text: 'Original words.' }],
  translationSegments: [{ id: 0, start: 0.5, end: 2.75, text: '原始译文。' }],
  outputFiles: {}, logs: [{ timestamp: '2026-10-19T01:00:30.000Z', level: 'info', message: '翻译已完成', context: 'translation' }]
});

const historyFixture = (id: string, outputDir?: string): HistoryRecord => ({
  id, sourceType: 'link', displayName: 'fixture', status: 'completed',
  createdAt: '2026-10-19T01:00:00.000Z', finishedAt: '2026-10-19T01:01:00.000Z',
  translateToChinese: true, downloadBehavior: 'transcribe', videoQuality: 'best', outputDir
});

test('complete history results persist independently of the queue and safely recover legacy artifacts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-history-results-'));
  const previous = { data: process.env.WHISPER_DATA_DIR, output: process.env.WHISPER_OUTPUT_DIR };
  process.env.WHISPER_DATA_DIR = path.join(root, 'data');
  process.env.WHISPER_OUTPUT_DIR = path.join(root, 'outputs');
  t.after(() => {
    if (previous.data === undefined) delete process.env.WHISPER_DATA_DIR;
    else process.env.WHISPER_DATA_DIR = previous.data;
    if (previous.output === undefined) delete process.env.WHISPER_OUTPUT_DIR;
    else process.env.WHISPER_OUTPUT_DIR = previous.output;
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const storage = await import('../src/main/task-results');
  const store = await import('../src/main/store');
  const { TaskManager } = await import('../src/main/task-manager');

  await t.test('round trips the full record atomically using a hashed filename', () => {
    const task = taskFixture('../../unusual 😀 id');
    storage.saveTaskResult(task);
    assert.deepEqual(storage.readTaskResult(task.id), task);
    const filenames = fs.readdirSync(path.join(root, 'data', 'task-results'));
    assert.deepEqual(filenames, [`${createHash('sha256').update(task.id).digest('hex')}.json`]);
    storage.removeTaskResult(task.id);
    assert.equal(storage.readTaskResult(task.id), undefined);
    const download = { ...taskFixture('download-only'), downloadBehavior: 'downloadOnly', language: null } as unknown as TaskRecord;
    storage.saveTaskResult(download);
    assert.deepEqual(storage.readTaskResult(download.id), download);
    storage.removeTaskResult(download.id);
  });

  await t.test('preserves over fifty summaries in both store and finalization', () => {
    const history = Array.from({ length: 51 }, (_, index) => historyFixture(`older-${index}`));
    store.saveHistoryRecords(history);
    assert.equal(store.getHistoryRecords().length, 51);
    const manager = new TaskManager() as any;
    manager.finalizeHistory(taskFixture('latest'));
    assert.equal(manager.getSnapshot().history.length, 52);
    assert.equal(store.getHistoryRecords().length, 52);
    assert.equal(manager.getSnapshot().history[0].transcriptText, undefined);
  });

  await t.test('a same-ID retry cannot replace the finished history result or its export', async () => {
    const manager = new TaskManager() as any;
    const task = taskFixture('retry');
    task.outputFiles.transcriptTxt = path.join(root, 'previous.txt');
    manager.tasks.push(task);
    manager.finalizeHistory(task);
    const before = structuredClone(task);
    // Retry is represented without running any worker or real task pipeline.
    Object.assign(task, { status: 'transcribing', transcriptText: 'new unfinished text',
      translationText: undefined, outputFiles: { transcriptTxt: path.join(root, 'new-run.txt') } });
    assert.deepEqual(manager.getHistoryResult(task.id), before);
    assert.equal(manager.getHistoryFilePath(task.id, 'transcriptTxt'), before.outputFiles.transcriptTxt);
    assert.equal(manager.getTaskFilePath(task.id, 'transcriptTxt'), task.outputFiles.transcriptTxt);
    task.status = 'completed';
    assert.equal(await manager.removeTask(task.id), true);
    const restarted = new TaskManager();
    assert.deepEqual(restarted.getHistoryResult(task.id), before);
    assert.equal(restarted.getTaskFilePath(task.id, 'transcriptTxt'), before.outputFiles.transcriptTxt);
    assert.equal(restarted.getHistoryResult('does-not-exist'), undefined);
    await restarted.removeHistoryItem(task.id);
    assert.equal(storage.readTaskResult(task.id), undefined);
  });

  await t.test('recovers metadata, source/translation JSON, BOM text, subtitles, logs and media only inside the registered directory', () => {
    const directory = path.join(root, 'outputs', 'legacy');
    fs.mkdirSync(directory, { recursive: true });
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ text: 'must never be read' }));
    fs.writeFileSync(path.join(directory, 'fixture.task.json'), JSON.stringify({
      taskId: 'legacy', input: 'https://example.invalid/legacy', sourceType: 'link', displayName: 'fixture', language: 'en',
      mediaInfo: { downloadedKind: 'video', durationSeconds: 4 }, segments: [{ start: 1, end: 2, text: 'metadata fallback' }],
      outputFiles: { transcriptJson: outside }, transcriptJson: outside, outputDir: root
    }));
    fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify({ text: 'Original full text', segments: [{ id: 4, start: 1, end: 2, text: 'Original full text' }] }));
    fs.writeFileSync(path.join(directory, 'fixture.zh.json'), JSON.stringify({ text: '完整译文', segments: [{ id: 4, start: 1, end: 2, text: '完整译文' }] }));
    for (const suffix of ['.txt', '.zh.txt']) fs.writeFileSync(path.join(directory, `fixture${suffix}`), '\uFEFFtext fixture');
    for (const suffix of ['.srt', '.vtt', '.zh.srt', '.zh.vtt']) fs.writeFileSync(path.join(directory, `fixture${suffix}`), 'subtitle fixture');
    fs.writeFileSync(path.join(directory, 'fixture.worker.log'), `${JSON.stringify({ timestamp: 'saved-time', level: 'warning', message: 'saved worker message', context: 'worker' })}\ninvalid trailing line`);
    fs.writeFileSync(path.join(directory, 'movie.mp4'), 'opaque media fixture');
    fs.writeFileSync(path.join(directory, 'audio.wav'), 'opaque audio fixture');
    const result = storage.recoverTaskResult(historyFixture('legacy', directory));
    assert.equal(result.transcriptText, 'Original full text');
    assert.equal(result.translationText, '完整译文');
    assert.equal(result.transcriptSegments?.[0].id, 4);
    assert.equal(result.translationSegments?.[0].start, 1);
    assert.equal(result.input, 'https://example.invalid/legacy');
    assert.equal(result.mediaInfo?.durationSeconds, 4);
    assert.equal(result.logs[0].message, 'saved worker message');
    assert.equal(result.outputFiles.downloadedMedia, path.join(directory, 'movie.mp4'));
    assert.equal(Object.keys(result.outputFiles).length, 13);
    for (const filename of Object.values(result.outputFiles)) assert.equal(path.dirname(filename), directory);
    fs.rmSync(path.join(directory, 'fixture.json'));
    fs.rmSync(path.join(directory, 'fixture.zh.json'));
    const textFallback = storage.recoverTaskResult(historyFixture('legacy', directory));
    assert.equal(textFallback.transcriptText, 'text fixture');
    assert.equal(textFallback.translationText, 'text fixture');
    assert.equal(textFallback.transcriptSegments?.[0].text, 'metadata fallback');
  });

  await t.test('missing legacy output can be restored and read again, and malformed snapshots are ignored', () => {
    const directory = path.join(root, 'outputs', 'restored');
    const record = historyFixture('restored', directory);
    store.saveHistoryRecords([record]);
    const manager = new TaskManager();
    assert.equal(manager.getHistoryResult(record.id)?.transcriptText, undefined);
    assert.equal(storage.readTaskResult(record.id), undefined);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'fixture.task.json'), JSON.stringify({ taskId: record.id, displayName: 'fixture' }));
    fs.writeFileSync(path.join(directory, 'fixture.txt'), '\uFEFFRestored original');
    assert.equal(manager.getHistoryResult(record.id)?.transcriptText, 'Restored original');
    const damaged = taskFixture(record.id) as any;
    damaged.logs[0].context = { invalid: 'shape' };
    storage.saveTaskResult(damaged);
    assert.equal(storage.readTaskResult(record.id), undefined);
    assert.equal(manager.getHistoryResult(record.id)?.transcriptText, 'Restored original');
    damaged.logs = [];
    damaged.outputFiles.transcriptTxt = { invalid: 'path' };
    storage.saveTaskResult(damaged);
    assert.equal(storage.readTaskResult(record.id), undefined);
    storage.removeTaskResult(record.id);
  });

  await t.test('subtitle-only legacy files retain cue timings and unknown metadata does not fabricate a result', () => {
    const directory = path.join(root, 'outputs', 'subtitles');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'fixture.task.json'), JSON.stringify({ taskId: 'subtitles', displayName: 'fixture' }));
    fs.writeFileSync(path.join(directory, 'fixture.srt'), '1\n00:00:01,250 --> 00:00:03,500\nOriginal subtitle\n');
    fs.writeFileSync(path.join(directory, 'fixture.zh.vtt'), 'WEBVTT\n\n00:01.250 --> 00:03.500\n字幕译文\n');
    const result = storage.recoverTaskResult(historyFixture('subtitles', directory));
    assert.equal(result.transcriptText, 'Original subtitle');
    assert.equal(result.translationText, '字幕译文');
    assert.equal(result.transcriptSegments?.[0].start, 1.25);
    assert.equal(result.translationSegments?.[0].end, 3.5);
    const wrongId = storage.recoverTaskResult(historyFixture('unrelated', directory));
    assert.equal(wrongId.transcriptText, undefined);
    assert.deepEqual(wrongId.outputFiles, {});
    const missing = storage.recoverTaskResult({ ...historyFixture('missing', path.join(root, 'missing')), status: 'failed', error: 'Original failure' });
    assert.equal(missing.status, 'failed');
    assert.equal(missing.error, 'Original failure');
    assert.equal(missing.transcriptText, undefined);
    assert.ok(missing.warning);
  });

  await t.test('completed local uploads remain available after leaving the queue and aging past cleanup', async () => {
    const uploadDir = path.join(root, 'data', 'uploads');
    const outputDir = path.join(root, 'outputs', 'local-finished');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const upload = path.join(uploadDir, 'completed-local.wav');
    const outputMedia = path.join(outputDir, 'result.wav');
    fs.writeFileSync(upload, 'opaque uploaded media fixture');
    fs.writeFileSync(outputMedia, 'opaque output media fixture');
    const task = { ...taskFixture('local-finished'), sourceType: 'file', input: upload, outputDir,
      outputFiles: { sourceMedia: upload, audio: outputMedia } } as TaskRecord;
    const manager = new TaskManager() as any;
    manager.tasks.push(task);
    manager.finalizeHistory(task);
    assert.equal(manager.getSnapshot().history.find((item: HistoryRecord) => item.id === task.id).input, upload);
    assert.equal(await manager.removeTask(task.id), true);
    assert.ok(fs.existsSync(upload));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(upload, eightDaysAgo, eightDaysAgo);
    const restarted = new TaskManager() as any;
    await restarted.cleanupStorage();
    assert.ok(fs.existsSync(upload));
    await restarted.clearHistory();
    assert.ok(fs.existsSync(upload));
    assert.ok(fs.existsSync(outputMedia));
  });

  await t.test('deleting outputs preserves cached content and clearing history only removes result caches', async (subtest) => {
    const directory = path.join(root, 'outputs', 'delete-output');
    fs.mkdirSync(directory, { recursive: true });
    const task = taskFixture('delete-output');
    task.outputDir = directory;
    task.outputFiles.transcriptTxt = path.join(directory, 'result.txt');
    fs.writeFileSync(task.outputFiles.transcriptTxt, task.transcriptText!);
    const manager = new TaskManager() as any;
    subtest.mock.method(manager, 'appendTaskLog', () => {});
    manager.tasks.push(task);
    manager.finalizeHistory(task);
    const before = structuredClone(task);
    assert.equal(await manager.deleteTaskDirectory(task.id), true);
    const saved = manager.getHistoryResult(task.id);
    assert.equal(saved.transcriptText, before.transcriptText);
    assert.equal(saved.translationText, before.translationText);
    assert.deepEqual(saved.logs, before.logs);
    assert.equal(saved.outputDir, undefined);
    assert.deepEqual(saved.outputFiles, {});
    assert.equal(manager.getSnapshot().history.find((item: HistoryRecord) => item.id === task.id).outputDir, undefined);
    const media = path.join(root, 'keep-media.mp4');
    fs.writeFileSync(media, 'opaque fixture');
    await manager.clearHistory();
    assert.equal(storage.readTaskResult(task.id), undefined);
    assert.ok(fs.existsSync(media));
  });

  await t.test('history HTTP result and exports use the archived scope, with useful missing responses', async () => {
    const { createWebServer } = await import('../src/server/http-server');
    const task = taskFixture('http-history');
    const artifact = path.join(root, 'http-transcript.txt');
    fs.writeFileSync(artifact, task.transcriptText!);
    task.outputFiles.transcriptTxt = artifact;
    const manager = {
      getHistoryResult: (id: string) => id === task.id ? task : undefined,
      getHistoryFilePath: (id: string, kind: string) => id === task.id && kind === 'transcriptTxt' ? artifact : undefined,
      getTaskFilePath: () => { throw new Error('History export must never resolve the live task.'); }
    } as unknown as Parameters<typeof createWebServer>[0];
    const server = createWebServer(manager, { host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${base}/api/history/${task.id}/result`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), task);
      const exported = await fetch(`${base}/api/history/${task.id}/files/transcriptTxt`);
      assert.equal(exported.status, 200);
      assert.equal(await exported.text(), task.transcriptText);
      for (const route of ['/api/history/missing/result', '/api/history/missing/files/transcriptTxt']) {
        const missing = await fetch(base + route);
        assert.equal(missing.status, 404);
        await missing.text();
      }
      const invalid = await fetch(`${base}/api/history/${task.id}/files/unrecognized`);
      assert.equal(invalid.status, 400);
      await invalid.text();
      fs.rmSync(artifact);
      const deletedFile = await fetch(`${base}/api/history/${task.id}/files/transcriptTxt`);
      assert.equal(deletedFile.status, 404);
      await deletedFile.text();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
