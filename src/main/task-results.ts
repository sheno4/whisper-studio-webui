import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { HistoryRecord, TaskLogEntry, TaskRecord, TranscriptSegment } from '../shared/types';
import { getDataDir } from './paths';

const resultPath = (id: string): string => path.join(
  getDataDir(), 'task-results', `${createHash('sha256').update(id).digest('hex')}.json`
);

const objectValue = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
);

const readJson = (filename: string): Record<string, unknown> | undefined => {
  try { return objectValue(JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''))); }
  catch { return undefined; }
};

export const saveTaskResult = (task: TaskRecord): void => {
  const target = resultPath(task.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(task)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

export const readTaskResult = (id: string): TaskRecord | undefined => {
  const value = readJson(resultPath(id));
  const optionalStringFields = ['transcriptText', 'translationText', 'outputDir', 'error', 'errorCode', 'warning'];
  const outputFiles = objectValue(value?.outputFiles);
  const mediaInfo = objectValue(value?.mediaInfo);
  if (!value || value.id !== id || !['completed', 'partial', 'failed', 'cancelled'].includes(String(value.status)) ||
      !['link', 'file'].includes(String(value.sourceType)) ||
      ['input', 'displayName', 'progressMessage', 'createdAt', 'updatedAt', 'transcriptionLanguage'].some((key) => typeof value[key] !== 'string') ||
      typeof value.translateToChinese !== 'boolean' || typeof value.attempts !== 'number' || !Number.isFinite(value.attempts) ||
      !['transcribe', 'downloadOnly', 'downloadThenTranscribe'].includes(String(value.downloadBehavior)) ||
      !['best', '1080p', '720p', '480p', 'audio'].includes(String(value.videoQuality)) ||
      optionalStringFields.some((key) => value[key] !== undefined && typeof value[key] !== 'string') ||
      // Older worker results use JSON null when a download-only task has no language.
      (value.language !== undefined && value.language !== null && typeof value.language !== 'string') ||
      (value.progressPercent !== undefined && (typeof value.progressPercent !== 'number' || !Number.isFinite(value.progressPercent))) ||
      (value.mediaInfo !== undefined && (!mediaInfo ||
        ['extractor', 'webpageUrl', 'downloadedExt', 'qualityFallbackMessage'].some((key) => mediaInfo[key] !== undefined && mediaInfo[key] !== null && typeof mediaInfo[key] !== 'string') ||
        (mediaInfo.durationSeconds !== undefined && mediaInfo.durationSeconds !== null &&
          (typeof mediaInfo.durationSeconds !== 'number' || !Number.isFinite(mediaInfo.durationSeconds))))) ||
      !outputFiles || Object.values(outputFiles).some((filename) => typeof filename !== 'string') ||
      !Array.isArray(value.logs) || value.logs.some((entry) => {
        const log = objectValue(entry);
        return !log || typeof log.timestamp !== 'string' || typeof log.message !== 'string' ||
          !['debug', 'info', 'warning', 'error'].includes(String(log.level)) ||
          (log.context !== undefined && typeof log.context !== 'string');
      }) || ['transcriptSegments', 'translationSegments'].some((key) => {
        const segments = value[key];
        return segments !== undefined && (!segmentsValue(segments) || (segments as unknown[]).some((item) => {
          const segment = objectValue(item);
          return !segment || typeof segment.id !== 'number' || !Number.isFinite(segment.id);
        }));
      })) return undefined;
  return value as unknown as TaskRecord;
};

export const removeTaskResult = (id: string): void => {
  fs.rmSync(resultPath(id), { force: true });
};

const segmentsValue = (value: unknown): TranscriptSegment[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const segments: TranscriptSegment[] = [];
  for (const [index, item] of value.entries()) {
    const segment = objectValue(item);
    if (!segment || typeof segment.text !== 'string' || typeof segment.start !== 'number' ||
        typeof segment.end !== 'number' || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) return undefined;
    segments.push({ id: typeof segment.id === 'number' ? segment.id : index,
      start: segment.start, end: segment.end, text: segment.text });
  }
  return segments;
};

const subtitleSegments = (text: string): TranscriptSegment[] => {
  const result: TranscriptSegment[] = [];
  const time = (value: string): number => {
    const fields = value.replace(',', '.').split(':').map(Number);
    return fields.reduce((total, field) => total * 60 + field, 0);
  };
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;
    const match = lines[timingIndex].match(/((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/);
    if (!match) continue;
    result.push({ id: result.length, start: time(match[1]), end: time(match[2]), text: lines.slice(timingIndex + 1).join('\n').trimEnd() });
  }
  return result;
};

const outputBaseName = (value: string, stripDots = false): string => {
  let cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripDots) cleaned = cleaned.replace(/^\.+|\.+$/g, '');
  return (cleaned.slice(0, 100) || (stripDots ? 'transcript' : 'translation')).trim();
};

const unavailableWarning = '该历史任务创建于完整结果保存功能启用前，部分原始结果或日志已无法恢复。';

/** Reads only files physically contained in the output directory registered in history. */
export const recoverTaskResult = (history: HistoryRecord): TaskRecord => {
  const task: TaskRecord = {
    id: history.id, sourceType: history.sourceType, input: '', displayName: history.displayName,
    status: history.status, progressPercent: ['completed', 'partial'].includes(history.status) ? 100 : undefined,
    progressMessage: ({ completed: '已完成', partial: '部分完成', failed: '任务失败', cancelled: '已取消' })[history.status],
    createdAt: history.createdAt, updatedAt: history.finishedAt, attempts: 0,
    translateToChinese: history.translateToChinese ?? false,
    downloadBehavior: history.downloadBehavior ?? 'transcribe', videoQuality: history.videoQuality ?? 'best',
    transcriptionLanguage: history.transcriptionLanguage ?? 'auto', language: history.language,
    outputDir: history.outputDir, outputFiles: {}, error: history.error, logs: [], warning: unavailableWarning
  };
  if (typeof history.durationSeconds === 'number') task.mediaInfo = {
    durationSeconds: history.durationSeconds, downloadBehavior: task.downloadBehavior, requestedQuality: task.videoQuality
  };
  if (!history.outputDir) return task;

  let root: string;
  let names: string[];
  try {
    root = fs.realpathSync(history.outputDir);
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    task.outputDir = undefined;
    return task;
  }
  const files = new Map(names.map((name) => [name.toLowerCase(), name]));
  const insideFile = (name?: string): string | undefined => {
    if (!name) return undefined;
    const known = files.get(name.toLowerCase());
    if (!known) return undefined;
    try {
      const resolved = fs.realpathSync(path.join(root, known));
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.lstatSync(resolved).isFile()) return undefined;
      return resolved;
    } catch { return undefined; }
  };
  const readText = (filename?: string): string | undefined => {
    if (!filename) return undefined;
    try { return fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''); }
    catch { return undefined; }
  };
  let metadata: Record<string, unknown> | undefined;
  let metadataName: string | undefined;
  const metadataNames = names.filter((name) => name.toLowerCase().endsWith('.task.json'));
  for (const name of metadataNames) {
    const filename = insideFile(name);
    const candidate = filename ? readJson(filename) : undefined;
    if (candidate?.taskId === history.id) { metadata = candidate; metadataName = name; break; }
  }
  // A directory belonging to another task must never be used as this record's result.
  if (metadataNames.length && !metadata) return task;
  if (metadata) {
    task.input = typeof metadata.input === 'string' ? metadata.input : '';
    task.language = typeof metadata.language === 'string' ? metadata.language : task.language;
    const mediaInfo = objectValue(metadata.mediaInfo);
    if (mediaInfo) {
      task.mediaInfo = { requestedQuality: task.videoQuality, downloadBehavior: task.downloadBehavior };
      for (const key of ['extractor', 'webpageUrl', 'downloadedExt', 'qualityFallbackMessage'] as const) {
        if (typeof mediaInfo[key] === 'string') task.mediaInfo[key] = mediaInfo[key];
      }
      if (typeof mediaInfo.durationSeconds === 'number' && Number.isFinite(mediaInfo.durationSeconds)) task.mediaInfo.durationSeconds = mediaInfo.durationSeconds;
      if (mediaInfo.downloadedKind === 'video' || mediaInfo.downloadedKind === 'audio') task.mediaInfo.downloadedKind = mediaInfo.downloadedKind;
    }
    task.outputFiles.metadataJson = insideFile(metadataName);
  }
  const transcriptBase = metadataName?.slice(0, -'.task.json'.length) ?? outputBaseName(history.displayName, true);
  const transcriptBases = [transcriptBase, outputBaseName(typeof metadata?.displayName === 'string' ? metadata.displayName : history.displayName, true)];
  const translationBase = outputBaseName(typeof metadata?.displayName === 'string' ? metadata.displayName : history.displayName);
  for (const [prefix, base] of [['transcript', transcriptBase], ['translation', `${translationBase}.zh`]] as const) {
    for (const [extension, suffix] of [['txt', 'Txt'], ['srt', 'Srt'], ['vtt', 'Vtt'], ['json', 'Json']] as const) {
      const file = (prefix === 'transcript' ? transcriptBases : [base]).map((candidate) => insideFile(`${candidate}.${extension}`)).find(Boolean);
      if (file) task.outputFiles[`${prefix}${suffix}`] = file;
    }
    const jsonPath = task.outputFiles[`${prefix}Json`];
    const data = jsonPath ? readJson(jsonPath) : undefined;
    const text = typeof data?.text === 'string' ? data.text : readText(task.outputFiles[`${prefix}Txt`]);
    const srt = readText(task.outputFiles[`${prefix}Srt`]);
    const vtt = readText(task.outputFiles[`${prefix}Vtt`]);
    const segments = segmentsValue(data?.segments) ?? (prefix === 'transcript' ? segmentsValue(metadata?.segments) : undefined)
      ?? (srt !== undefined ? subtitleSegments(srt) : vtt !== undefined ? subtitleSegments(vtt) : undefined);
    task[`${prefix}Text`] = text ?? (segments ? segments.map((segment) => segment.text).join(prefix === 'translation' ? '\n\n' : ' ').trim() : undefined);
    task[`${prefix}Segments`] = segments;
    if (prefix === 'transcript' && typeof data?.language === 'string') task.language = data.language;
  }
  const logPath = insideFile(`${transcriptBase}.worker.log`);
  if (logPath) {
    task.outputFiles.logFile = logPath;
    for (const line of (readText(logPath) ?? '').split(/\r?\n/).filter(Boolean)) {
      try {
        const log = objectValue(JSON.parse(line));
        if (log && typeof log.timestamp === 'string' && typeof log.message === 'string' &&
            ['debug', 'info', 'warning', 'error'].includes(String(log.level))) {
          task.logs.push({ timestamp: log.timestamp, level: log.level as TaskLogEntry['level'],
            message: log.message, context: typeof log.context === 'string' ? log.context : undefined });
        }
      } catch { /* An incomplete worker log line is not a result. */ }
    }
  }
  const media = names.map((name) => insideFile(name)).filter((file): file is string => Boolean(file));
  const audio = media.filter((file) => /\.(?:wav|mp3|m4a|aac|flac|ogg|opus|wma)$/i.test(file));
  const video = media.filter((file) => /\.(?:mp4|mov|mkv|webm|avi|flv|wmv|m4v|ts)$/i.test(file));
  if (audio.length === 1) task.outputFiles.audio = audio[0];
  if (task.sourceType === 'link') {
    const downloadedExt = task.mediaInfo?.downloadedExt?.toLowerCase();
    const matchingExtension = downloadedExt ? media.filter((file) => path.extname(file).slice(1).toLowerCase() === downloadedExt) : [];
    if (task.mediaInfo?.downloadedKind && matchingExtension.length === 1) task.outputFiles.downloadedMedia = matchingExtension[0];
    else if (task.mediaInfo?.downloadedKind === 'video' && video.length === 1) task.outputFiles.downloadedMedia = video[0];
    else if (task.mediaInfo?.downloadedKind === 'audio' && audio.length === 1) task.outputFiles.downloadedMedia = audio[0];
    task.outputFiles.sourceMedia = task.outputFiles.downloadedMedia ?? task.outputFiles.audio;
  }
  return task;
};
