import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import OpenAI from 'openai';

import type { TranscriptSegment, TranslationServiceTestResult } from '../shared/types';

export class TranslationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TranslationError';
    this.code = code;
  }
}

interface TranslateOptions {
  apiKey?: string;
  model: string;
  baseUrl: string;
  customContent: string;
  enableAiContext: boolean;
  systemPrompt: string;
  multiplePrompt: string;
  prompt: string;
  requestLimit: number;
  maxTextLengthPerRequest: number;
  maxTextGroupLengthPerRequest: number;
  enableRichTranslate: boolean;
  maxTextGroupLengthPerRequestForSubtitle: number;
  subtitlePrompt: string;
  temperature: number;
  outputDir: string;
  outputBaseName: string;
  onProgress?: (current: number, total: number) => void;
  onLog?: (message: string) => void;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
}

interface TestTranslationOptions {
  apiKey?: string;
  model: string;
  baseUrl: string;
  temperature: number;
  requestLimit?: number;
}

interface Strategy {
  mode: 'responses' | 'chat';
  baseUrl: string;
  label: string;
}

const TRANSLATION_SYSTEM_PROMPT =
  'You translate subtitle segments into Simplified Chinese. Return JSON only. Preserve meaning, tone, and line boundaries. Never merge, split, omit, or renumber segments.';

const normalizeBaseUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TranslationError('translation_url_required', '请先填写自定义翻译服务的接口地址。');
  }

  return trimmed.replace(/\/+$/, '');
};

const sanitizeOutputBaseName = (value: string): string => {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned.slice(0, 100) || 'translation').trim();
};

const buildBaseUrlCandidates = (baseUrl: string): string[] => {
  const normalized = normalizeBaseUrl(baseUrl);
  const candidates = [normalized];

  try {
    const parsed = new URL(normalized);
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/v1';
      candidates.push(parsed.toString().replace(/\/+$/, ''));
    }
  } catch {
    if (!normalized.endsWith('/v1')) {
      candidates.push(`${normalized}/v1`);
    }
  }

  return Array.from(new Set(candidates));
};

const buildStrategies = (baseUrl: string): Strategy[] => {
  const candidates = buildBaseUrlCandidates(baseUrl);
  const strategies: Strategy[] = [];

  for (const candidate of candidates) {
    strategies.push({ mode: 'responses', baseUrl: candidate, label: candidate });
  }

  for (const candidate of candidates) {
    strategies.push({ mode: 'chat', baseUrl: candidate, label: candidate });
  }

  return strategies;
};

const createClient = (apiKey: string | undefined, baseUrl: string): OpenAI => {
  return new OpenAI({
    apiKey: apiKey?.trim() || 'not-required',
    baseURL: baseUrl,
    maxRetries: 0,
    timeout: 60_000
  });
};

const createTestClient = (apiKey: string | undefined, baseUrl: string): OpenAI => {
  return new OpenAI({
    apiKey: apiKey?.trim() || 'not-required',
    baseURL: baseUrl,
    maxRetries: 0,
    timeout: 12_000
  });
};

const workingStrategyCache = new Map<string, Strategy>();

const translationServiceKey = (baseUrl: string, model: string): string => {
  let normalized = normalizeBaseUrl(baseUrl);
  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    normalized = parsed.toString().replace(/\/+$/, '');
  } catch {
    // Custom endpoint validation remains the client's responsibility.
  }
  return JSON.stringify([normalized, model.trim()]);
};

interface RequestStartOptions {
  signal?: AbortSignal;
  isCancelled?: () => boolean;
}

class RequestStartQueue {
  private nextStartAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly waiting: Array<{
    interval: number;
    options: RequestStartOptions;
    resolve: () => void;
    reject: (error: TranslationError) => void;
    abort: () => void;
  }> = [];

  acquire(interval: number, options: RequestStartOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted || options.isCancelled?.()) {
        reject(new TranslationError('cancelled', '翻译任务已取消。'));
        return;
      }
      const entry = {
        interval, options, resolve, reject,
        abort: () => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          options.signal?.removeEventListener('abort', entry.abort);
          reject(new TranslationError('cancelled', '翻译任务已取消。'));
          this.pump();
        }
      };
      this.waiting.push(entry);
      options.signal?.addEventListener('abort', entry.abort, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.waiting.length > 0) {
      const entry = this.waiting[0];
      if (entry.options.signal?.aborted || entry.options.isCancelled?.()) {
        this.waiting.shift();
        entry.options.signal?.removeEventListener('abort', entry.abort);
        entry.reject(new TranslationError('cancelled', '翻译任务已取消。'));
        continue;
      }
      const remaining = this.nextStartAt - performance.now();
      if (remaining > 0) {
        this.timer = setTimeout(() => this.pump(), Math.ceil(remaining));
        return;
      }
      this.waiting.shift();
      entry.options.signal?.removeEventListener('abort', entry.abort);
      this.nextStartAt = performance.now() + entry.interval;
      entry.resolve();
    }
  }
}

const requestStartQueues = new Map<string, RequestStartQueue>();

const acquireRequestStart = async (
  options: RequestStartOptions & { baseUrl: string; model: string; requestLimit?: number }
): Promise<void> => {
  if (!options.requestLimit || options.requestLimit <= 0) return;
  const key = translationServiceKey(options.baseUrl, options.model);
  let queue = requestStartQueues.get(key);
  if (!queue) {
    queue = new RequestStartQueue();
    requestStartQueues.set(key, queue);
  }
  await queue.acquire(Math.ceil(1000 / options.requestLimit), options);
};

const throwIfCancelled = (options: TranslateOptions): void => {
  if (options.signal?.aborted || options.isCancelled?.()) {
    throw new TranslationError('cancelled', '翻译任务已取消。');
  }
};

const wait = async (ms: number, options: TranslateOptions): Promise<void> => {
  throwIfCancelled(options);
  try {
    await delay(ms, undefined, { signal: options.signal });
  } catch (error) {
    throwIfCancelled(options);
    throw error;
  }
  throwIfCancelled(options);
};

const buildSegmentBatches = <T extends TranscriptSegment>(
  segments: T[],
  maximumSegments: number,
  maximumCharacters: number
): T[][] => {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;

  for (const segment of segments) {
    const textLength = Array.from(segment.text).length;
    const shouldFlush =
      current.length >= maximumSegments ||
      (current.length > 0 && currentChars + textLength > maximumCharacters);

    if (shouldFlush) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(segment);
    currentChars += textLength;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches.length > 0 ? batches : [[]];
};

const buildSystemPrompt = (options: TranslateOptions): string => {
  return [
    options.systemPrompt.trim() || TRANSLATION_SYSTEM_PROMPT,
    options.customContent.trim() ? `Translation strategy supplied by the user:\n${options.customContent.trim()}` : '',
    options.enableAiContext ? 'Use neighboring subtitle segments as context while preserving every line boundary.' : '',
    options.enableRichTranslate ? 'Preserve lightweight markup and links when they appear in the source text.' : ''
  ].filter(Boolean).join('\n\n');
};

const buildBatchPrompt = (segments: TranscriptSegment[], options: TranslateOptions): string => {
  const configuredPrompt = (
    options.subtitlePrompt.trim() ||
    (segments.length > 1 ? options.multiplePrompt.trim() : options.prompt.trim())
  );
  return [
    configuredPrompt,
    'Translate the following subtitle texts into Simplified Chinese.',
    'Return a strict JSON array of strings.',
    'The array length must exactly match the input length.',
    'Each output item must correspond to the subtitle text at the same index.',
    'Do not include explanations or extra fields.',
    '',
    JSON.stringify(segments.map((segment) => segment.text), null, 2)
  ].join('\n');
};

const extractResponsesOutputText = (response: unknown): string => {
  if (
    typeof response === 'object' &&
    response !== null &&
    'output_text' in response &&
    typeof (response as { output_text?: unknown }).output_text === 'string'
  ) {
    return (response as { output_text: string }).output_text;
  }

  if (
    typeof response === 'object' &&
    response !== null &&
    'output' in response &&
    Array.isArray((response as { output?: unknown[] }).output)
  ) {
    const output = (response as { output: Array<{ content?: Array<{ text?: string }> }> }).output;
    const parts = output.flatMap((item) => item.content ?? []).map((item) => item.text ?? '');
    return parts.join('\n').trim();
  }

  return '';
};

const extractChatOutputText = (response: unknown): string => {
  if (
    typeof response === 'object' &&
    response !== null &&
    'choices' in response &&
    Array.isArray((response as { choices?: unknown[] }).choices)
  ) {
    const firstChoice = (response as { choices: Array<{ message?: { content?: unknown } }> }).choices[0];
    const content = firstChoice?.message?.content;

    if (typeof content === 'string') {
      return content.trim();
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'object' && item !== null && 'text' in item) {
            const text = (item as { text?: unknown }).text;
            return typeof text === 'string' ? text : '';
          }
          return '';
        })
        .join('\n')
        .trim();
    }
  }

  return '';
};

const requestWithStrategy = async (
  client: OpenAI,
  strategy: Strategy,
  prompt: string,
  options: TranslateOptions
): Promise<string> => {
  throwIfCancelled(options);
  await acquireRequestStart(options);
  throwIfCancelled(options);
  if (strategy.mode === 'responses') {
    const response = await client.responses.create({
      model: options.model,
      instructions: buildSystemPrompt(options),
      input: prompt,
      temperature: options.temperature
    }, { signal: options.signal });

    return extractResponsesOutputText(response).trim();
  }

  const response = await client.chat.completions.create({
    model: options.model,
    temperature: options.temperature,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(options)
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  }, { signal: options.signal });

  return extractChatOutputText(response).trim();
};

const parseTranslatedBatch = (rawText: string, expectedCount: number): string[] => {
  const normalized = rawText
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  const firstBracket = normalized.indexOf('[');
  const lastBracket = normalized.lastIndexOf(']');
  const candidate =
    firstBracket !== -1 && lastBracket !== -1 ? normalized.slice(firstBracket, lastBracket + 1) : normalized;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new TranslationError('translation_parse_failed', '翻译接口返回的结果不是可解析的 JSON 数组。');
  }

  if (!Array.isArray(parsed) || parsed.length !== expectedCount || parsed.some((item) => typeof item !== 'string')) {
    throw new TranslationError('translation_parse_failed', '翻译接口返回的段落数量和原字幕不一致。');
  }

  return parsed.map((item) => item.trim());
};

const tryStrategy = async (
  strategy: Strategy,
  options: TranslateOptions,
  prompt: string,
  expectedCount: number
): Promise<string[]> => {
  const client = createClient(options.apiKey, strategy.baseUrl);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    throwIfCancelled(options);
    try {
      const translated = await requestWithStrategy(client, strategy, prompt, options);
      throwIfCancelled(options);
      return parseTranslatedBatch(translated, expectedCount);
    } catch (error) {
      throwIfCancelled(options);
      if (attempt >= 2) {
        throw error;
      }

      options.onLog?.(
        `字幕翻译请求重试中：${strategy.mode === 'responses' ? 'Responses API' : 'Chat Completions'} / ${strategy.label}`
      );
      await wait(900 * attempt, options);
    }
  }

  throw new TranslationError('translation_failed', '翻译请求失败了。');
};

const formatStrategyLabel = (strategy: Strategy): string => {
  return `${strategy.mode === 'responses' ? 'Responses API' : 'Chat Completions'} @ ${strategy.label}`;
};

export const testTranslationServiceConnection = async (
  options: TestTranslationOptions
): Promise<TranslationServiceTestResult> => {
  const startedAt = Date.now();
  const failures: string[] = [];
  const instructions = 'You are testing a translation endpoint. Follow the request and return translated text only.';
  const prompt = 'Translate "Hello, world!" into Simplified Chinese. Reply with the translated text only.';

  for (const strategy of buildStrategies(options.baseUrl)) {
    try {
      const client = createTestClient(options.apiKey, strategy.baseUrl);
      let output = '';
      await acquireRequestStart(options);

      if (strategy.mode === 'responses') {
        const response = await client.responses.create({
          model: options.model,
          instructions,
          input: prompt,
          temperature: options.temperature
        });
        output = extractResponsesOutputText(response).trim();
      } else {
        const response = await client.chat.completions.create({
          model: options.model,
          temperature: options.temperature,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: prompt }
          ]
        });
        output = extractChatOutputText(response).trim();
      }

      if (!output) {
        throw new Error('接口返回了空内容。');
      }

      return {
        ok: true,
        mode: strategy.mode,
        endpoint: strategy.baseUrl,
        latencyMs: Date.now() - startedAt,
        responsePreview: output.replace(/\s+/g, ' ').slice(0, 160)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${formatStrategyLabel(strategy)}：${message}`);
    }
  }

  throw new TranslationError(
    'translation_test_failed',
    `翻译服务测试失败。${failures.slice(-2).join('；')}`
  );
};

const resolveWorkingStrategy = async (
  prompt: string,
  expectedCount: number,
  options: TranslateOptions
): Promise<{ strategy: Strategy; translated: string[] }> => {
  const strategies = buildStrategies(options.baseUrl);
  let lastError: unknown;

  for (const strategy of strategies) {
    throwIfCancelled(options);
    try {
      options.onLog?.(`尝试字幕翻译接口：${formatStrategyLabel(strategy)}`);
      const translated = await tryStrategy(
        strategy,
        options,
        prompt,
        expectedCount
      );

      if (strategy.mode === 'chat') {
        options.onLog?.('当前接口未成功走通 Responses API，已自动切换到兼容模式继续翻译字幕。');
      }

      return { strategy, translated };
    } catch (error) {
      throwIfCancelled(options);
      lastError = error;
    }
  }

  const rawMessage = lastError instanceof Error ? lastError.message : '翻译请求失败了。';
  const message = `翻译失败：当前自定义接口地址没有成功兼容字幕翻译请求。请确认地址是否需要带 /v1，且所选模型支持 Responses 或 Chat Completions。原始错误：${rawMessage}`;

  throw new TranslationError('translation_failed', message);
};

const formatTimestamp = (seconds: number, variant: 'srt' | 'vtt'): string => {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  const separator = variant === 'srt' ? ',' : '.';

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(secs).padStart(2, '0')
  ].join(':') + `${separator}${String(milliseconds).padStart(3, '0')}`;
};

const buildSubtitleFile = (segments: TranscriptSegment[], variant: 'srt' | 'vtt'): string => {
  const blocks = segments.map((segment, index) => {
    const timing = `${formatTimestamp(segment.start, variant)} --> ${formatTimestamp(segment.end, variant)}`;
    if (variant === 'srt') {
      return `${index + 1}\n${timing}\n${segment.text}`;
    }

    return `${timing}\n${segment.text}`;
  });

  return variant === 'vtt' ? `WEBVTT\n\n${blocks.join('\n\n')}\n` : `${blocks.join('\n\n')}\n`;
};

const writeTranslationArtifacts = async (
  segments: TranscriptSegment[],
  options: TranslateOptions
): Promise<{
  text: string;
  segments: TranscriptSegment[];
  outputFiles: {
    translationTxt: string;
    translationSrt: string;
    translationVtt: string;
    translationJson: string;
  };
}> => {
  const baseName = sanitizeOutputBaseName(options.outputBaseName);
  const txtPath = path.join(options.outputDir, `${baseName}.zh.txt`);
  const srtPath = path.join(options.outputDir, `${baseName}.zh.srt`);
  const vttPath = path.join(options.outputDir, `${baseName}.zh.vtt`);
  const jsonPath = path.join(options.outputDir, `${baseName}.zh.json`);
  const mergedText = segments.map((segment) => segment.text).join('\n\n').trim();

  const artifacts = [
    [txtPath, `\uFEFF${mergedText}`],
    [srtPath, buildSubtitleFile(segments, 'srt')],
    [vttPath, buildSubtitleFile(segments, 'vtt')],
    [jsonPath, JSON.stringify({ text: mergedText, segments }, null, 2)]
  ];
  const writtenPaths: string[] = [];
  try {
    for (const [filePath, content] of artifacts) {
      throwIfCancelled(options);
      writtenPaths.push(filePath);
      await fs.writeFile(filePath, content, { encoding: 'utf8', signal: options.signal });
      throwIfCancelled(options);
    }
  } catch (error) {
    if (options.signal?.aborted || options.isCancelled?.()) {
      await Promise.all(writtenPaths.map((filePath) => fs.rm(filePath, { force: true })));
      throwIfCancelled(options);
    }
    throw error;
  }

  return {
    text: mergedText,
    segments,
    outputFiles: {
      translationTxt: txtPath,
      translationSrt: srtPath,
      translationVtt: vttPath,
      translationJson: jsonPath
    }
  };
};

export const translateSegmentsToChinese = async (
  transcriptText: string,
  segments: TranscriptSegment[],
  options: TranslateOptions
): Promise<{
  text: string;
  segments: TranscriptSegment[];
  outputFiles: {
    translationTxt: string;
    translationSrt: string;
    translationVtt: string;
    translationJson: string;
  };
}> => {
  const sourceSegments =
    segments.length > 0
      ? segments
      : [
          {
            id: 0,
            start: 0,
            end: 0,
            text: transcriptText.trim()
          }
        ];

  const maximumCharacters = Math.max(1, Math.floor(options.maxTextLengthPerRequest));
  const chunks = sourceSegments.flatMap((segment, sourceIndex) => {
    const characters = Array.from(segment.text);
    const parts: Array<TranscriptSegment & { sourceIndex: number }> = [];
    for (let offset = 0; offset < characters.length || offset === 0; offset += maximumCharacters) {
      parts.push({ ...segment, sourceIndex, text: characters.slice(offset, offset + maximumCharacters).join('') });
    }
    return parts;
  });
  const batches = buildSegmentBatches(
    chunks,
    Math.min(options.maxTextGroupLengthPerRequest, options.maxTextGroupLengthPerRequestForSubtitle),
    maximumCharacters
  );
  const translatedParts: string[][] = sourceSegments.map(() => []);
  const strategyCacheKey = translationServiceKey(options.baseUrl, options.model);
  let strategy = workingStrategyCache.get(strategyCacheKey);

  for (let index = 0; index < batches.length; index += 1) {
    throwIfCancelled(options);

    options.onProgress?.(index, batches.length);

    const batch = batches[index];
    const prompt = buildBatchPrompt(batch, options);

    let translatedTexts: string[];
    if (!strategy) {
      const firstResult = await resolveWorkingStrategy(prompt, batch.length, options);
      strategy = firstResult.strategy;
      workingStrategyCache.set(strategyCacheKey, strategy);
      translatedTexts = firstResult.translated;
    } else {
      try {
        translatedTexts = await tryStrategy(
          strategy,
          options,
          prompt,
          batch.length
        );
      } catch {
        throwIfCancelled(options);
        workingStrategyCache.delete(strategyCacheKey);
        const nextResult = await resolveWorkingStrategy(prompt, batch.length, options);
        strategy = nextResult.strategy;
        workingStrategyCache.set(strategyCacheKey, strategy);
        translatedTexts = nextResult.translated;
      }
    }

    throwIfCancelled(options);
    batch.forEach((segment, segmentIndex) => {
      translatedParts[segment.sourceIndex].push(translatedTexts[segmentIndex]);
    });
  }

  options.onProgress?.(batches.length, batches.length);
  throwIfCancelled(options);
  const translatedSegments = sourceSegments.map((segment, index) => ({
    ...segment,
    text: translatedParts[index].join('')
  }));
  return writeTranslationArtifacts(translatedSegments, options);
};
