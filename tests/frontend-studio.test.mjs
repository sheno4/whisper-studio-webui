import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('tsx'))('esbuild');
const bundle = buildSync({ stdin: {
  contents: "export * from './src/renderer/studio/navigation'; export * from './src/renderer/studio/content/transcript'; export * from './src/renderer/studio/content/import-result'; export * from './src/renderer/studio/preferences/draft';",
  resolveDir: fileURLToPath(new URL('..', import.meta.url))
}, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', bundle)(module, module.exports);
const { parseStudioRoute, routeHash, pairSegments, literalMatches, formatTimestamp, mergeTranscript, createPreferencesDraft, clearSubmittedKeys, preferencesIssue } = module.exports;

test('file import recognizes sanitized Linux names and ignores unrelated system errors', () => {
  const { matchesImportedFile, isImportError } = module.exports;
  assert.equal(matchesImportedFile({ input: '/uploads/uuid/interview_part.wav', displayName: 'interview_part.wav' }, ['interview:part.wav']), true);
  const longName = '段'.repeat(200) + '.wav';
  const shortened = '段'.repeat(176) + '.wav';
  assert.equal(matchesImportedFile({ input: `/uploads/${shortened}`, displayName: shortened }, [longName]), true);
  assert.equal(matchesImportedFile({ input: '/uploads/not-my-record.wav', displayName: 'other' }, ['record.wav']), false);
  assert.equal(isImportError({ tone: 'error', title: '模型准备失败' }, 'file'), false);
  assert.equal(isImportError({ tone: 'error', title: '拖放导入失败' }, 'file'), true);
  assert.equal(isImportError({ tone: 'error', title: '任务创建失败' }, 'link'), true);
});

test('reader deep links round-trip unusual ids and malformed browser history stays usable', () => {
  for (const kind of ['task', 'history']) {
    const route = { kind, id: '中文 😀 /#? 100%' };
    assert.deepEqual(parseStudioRoute(routeHash(route)), route);
  }
  for (const hash of ['', '#/library', '#/task/', '#/task/%ZZ', '#/unexpected']) assert.deepEqual(parseStudioRoute(hash), { kind: 'library' });
});

test('partial translation keeps matching later ids and never loses an unmatched subtitle', () => {
  const original = [{ id: 0, start: 0, end: 1, text: 'First.' }, { id: 1, start: 1, end: 2, text: 'Second.' }, { id: 2, start: 2, end: 3, text: 'Third.' }];
  const translated = [{ id: 1, start: 1, end: 2, text: '第二句。' }, { id: 9, start: 9, end: 10, text: '额外译文。' }];
  const rows = pairSegments(original, translated);
  assert.equal(rows.find((row) => row.original === 'First.').translation, undefined);
  assert.equal(rows.find((row) => row.original === 'Second.').translation, '第二句。');
  assert.deepEqual(rows.map((row) => row.original).filter(Boolean), original.map((segment) => segment.text));
  assert.deepEqual(rows.map((row) => row.translation).filter(Boolean).sort(), translated.map((segment) => segment.text).sort());
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
});

test('reader search is literal and Unicode offsets and subtitle time boundaries stay exact', () => {
  const text = '😀 [a+b] 中文 [A+B] 😀';
  assert.deepEqual(literalMatches(text, '[a+b]').map((match) => text.slice(match.start, match.end)), ['[a+b]', '[A+B]']);
  assert.deepEqual(literalMatches(text, '😀').map((match) => text.slice(match.start, match.end)), ['😀', '😀']);
  assert.deepEqual(literalMatches(text, '  '), []);
  assert.equal(formatTimestamp(59.9996), '01:00.000');
  assert.equal(formatTimestamp(3599.9996), '01:00:00.000');
  assert.equal(formatTimestamp(Number.NaN), '00:00.000');
  assert.equal(mergeTranscript('', [{ text: ' 一 ', id: 0, start: 0, end: 1 }, { text: '二', id: 1, start: 1, end: 2 }]), '一\n二');
});

const service = { id: 'existing', name: '匿名接口', enabled: true, apiUrl: 'https://fixture.invalid/v1', model: 'fixture', customContent: '技术术语', enableAiContext: true, systemPrompt: '系统', multiplePrompt: '多段', prompt: '单段', requestLimit: 2, maxTextLengthPerRequest: 3600, maxTextGroupLengthPerRequest: 18, enableRichTranslate: true, maxTextGroupLengthPerRequestForSubtitle: 18, subtitlePrompt: '字幕', temperature: .2, apiKeyConfigured: true, apiKeySource: 'stored' };
const settings = { pythonPath: '/saved/python', outputDir: '/saved/output', whisperModel: 'custom/local-model', transcriptionEngine: 'faster-whisper', wallpaperPath: '/wallpaper', translateByDefault: true, translationServices: [service], activeTranslationServiceId: service.id, keepAudio: true, logLevel: 'debug', debugMode: true, maxConcurrentDownloads: 6, maxConcurrentTranscriptions: 2, maxConcurrentTranslations: 4, downloadConnections: 16, youtubeCookieSource: 'firefox', youtubeBrowserProfile: 'saved-profile' };

test('opening preferences preserves every saved configuration and sends no stored secret metadata', () => {
  const draft = createPreferencesDraft(settings);
  for (const [key, value] of Object.entries(settings)) if (key !== 'translationServices') assert.deepEqual(draft[key], value, key);
  const nextService = draft.translationServices[0];
  for (const [key, value] of Object.entries(service)) if (!['apiKeyConfigured', 'apiKeySource'].includes(key)) assert.deepEqual(nextService[key], value, key);
  assert.equal('apiKeyConfigured' in nextService, false);
  assert.equal('apiKeySource' in nextService, false);
  assert.equal(nextService.apiKey, '');
  assert.equal(nextService.clearApiKey, false);
  assert.equal(preferencesIssue(draft), undefined);
  nextService.apiKey = 'only-a-test-placeholder';
  nextService.clearApiKey = true;
  const cleared = clearSubmittedKeys(draft);
  assert.equal(cleared.translationServices[0].apiKey, '');
  assert.equal(cleared.translationServices[0].clearApiKey, false);
  assert.equal(nextService.apiKey, 'only-a-test-placeholder', 'clear after submission must not mutate the captured request');
});

test('invalid settings on a hidden page produce a specific category and service target', () => {
  const draft = createPreferencesDraft(settings);
  draft.translationServices[0].apiUrl = 'javascript:example';
  assert.equal(preferencesIssue(draft).category, 'translation');
  assert.equal(preferencesIssue(draft).serviceId, 'existing');
  draft.outputDir = '';
  assert.equal(preferencesIssue(draft).category, 'general');
});
