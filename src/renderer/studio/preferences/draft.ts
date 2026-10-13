import {
  DEFAULT_TRANSLATION_MAX_GROUP_LENGTH,
  DEFAULT_TRANSLATION_MAX_TEXT_LENGTH,
  DEFAULT_TRANSLATION_REQUEST_LIMIT,
  DEFAULT_TRANSLATION_TEMPERATURE,
  FASTER_WHISPER_MODEL_OPTIONS,
  OPENAI_WHISPER_MODEL_OPTIONS,
  WHISPER_CPP_MODEL_OPTIONS
} from '../../../shared/constants';
import type { SaveSettingsPayload, SettingsData, TranscriptionEngine, TranslationServiceInput } from '../../../shared/types';
import { createRandomId } from '../../utils';

export type PreferenceCategory = 'general' | 'runtime' | 'downloads' | 'translation' | 'appearance' | 'system';
export const MAX_TRANSLATION_SERVICES = 50;

export const engineModels: Record<TranscriptionEngine, readonly string[]> = {
  whisper: OPENAI_WHISPER_MODEL_OPTIONS,
  'faster-whisper': FASTER_WHISPER_MODEL_OPTIONS,
  'whisper.cpp': WHISPER_CPP_MODEL_OPTIONS
};

export function modelForEngine(engine: TranscriptionEngine, model: string): string {
  const models = engineModels[engine];
  return models.includes(model) ? model : models.includes('turbo') ? 'turbo' : models[0];
}

export function createPreferencesDraft(settings: SettingsData): SaveSettingsPayload {
  return {
    pythonPath: settings.pythonPath,
    outputDir: settings.outputDir,
    transcriptionEngine: settings.transcriptionEngine,
    // Opening preferences must retain custom faster-whisper repository/path
    // selections. Compatibility adjustment happens only on an engine change.
    whisperModel: settings.whisperModel,
    maxConcurrentDownloads: settings.maxConcurrentDownloads ?? 3,
    maxConcurrentTranscriptions: settings.maxConcurrentTranscriptions ?? 1,
    maxConcurrentTranslations: settings.maxConcurrentTranslations ?? 2,
    downloadConnections: settings.downloadConnections ?? 8,
    youtubeCookieSource: settings.youtubeCookieSource ?? 'auto',
    youtubeBrowserProfile: settings.youtubeBrowserProfile ?? '',
    wallpaperPath: settings.wallpaperPath ?? '',
    translateByDefault: settings.translateByDefault,
    keepAudio: settings.keepAudio,
    logLevel: settings.logLevel,
    debugMode: settings.debugMode,
    activeTranslationServiceId: settings.activeTranslationServiceId,
    translationServices: settings.translationServices.map(({ apiKeyConfigured: _configured, apiKeySource: _source, ...service }) => ({
      ...service, apiKey: '', clearApiKey: false
    }))
  };
}

export function emptyTranslationService(): TranslationServiceInput {
  return {
    id: createRandomId().replace(/-/g, ''),
    name: '新翻译服务',
    enabled: true,
    apiUrl: '',
    model: '',
    customContent: '',
    enableAiContext: false,
    systemPrompt: '',
    multiplePrompt: '',
    prompt: '',
    requestLimit: DEFAULT_TRANSLATION_REQUEST_LIMIT,
    maxTextLengthPerRequest: DEFAULT_TRANSLATION_MAX_TEXT_LENGTH,
    maxTextGroupLengthPerRequest: DEFAULT_TRANSLATION_MAX_GROUP_LENGTH,
    enableRichTranslate: false,
    maxTextGroupLengthPerRequestForSubtitle: DEFAULT_TRANSLATION_MAX_GROUP_LENGTH,
    subtitlePrompt: '',
    temperature: DEFAULT_TRANSLATION_TEMPERATURE,
    apiKey: '',
    clearApiKey: false
  };
}

export type ServiceNumberKey = 'requestLimit' | 'maxTextLengthPerRequest' | 'maxTextGroupLengthPerRequest' | 'maxTextGroupLengthPerRequestForSubtitle' | 'temperature';
export const serviceNumberFields: Array<{ key: ServiceNumberKey; label: string; min: number; max: number; step: number }> = [
  { key: 'requestLimit', label: '每秒请求数', min: 0.1, max: 100, step: 0.1 },
  { key: 'maxTextLengthPerRequest', label: '单次请求最多字符', min: 100, max: 100000, step: 1 },
  { key: 'maxTextGroupLengthPerRequest', label: '单次请求最多段落', min: 1, max: 200, step: 1 },
  { key: 'maxTextGroupLengthPerRequestForSubtitle', label: '单次字幕请求最多段落', min: 1, max: 200, step: 1 },
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.1 }
];

export interface DraftIssue { category: PreferenceCategory; message: string; serviceId?: string }

/** Validate the complete draft, including fields on a currently closed page. */
export function preferencesIssue(draft: SaveSettingsPayload): DraftIssue | undefined {
  if (!draft.outputDir.trim()) return { category: 'general', message: '请填写输出目录。' };
  if (!draft.pythonPath.trim()) return { category: 'runtime', message: '请填写 Python 路径。' };
  if (draft.translationServices.length > MAX_TRANSLATION_SERVICES) return { category: 'translation', message: `最多配置 ${MAX_TRANSLATION_SERVICES} 个翻译服务。` };
  for (const service of draft.translationServices) {
    const issue = (message: string): DraftIssue => ({ category: 'translation', serviceId: service.id, message: `${service.name.trim() || '新服务'}：${message}` });
    if (!service.name.trim()) return issue('请填写服务名称。');
    if (!service.model.trim()) return issue('请填写模型名称。');
    try {
      if (!['http:', 'https:'].includes(new URL(service.apiUrl.trim()).protocol)) return issue('接口地址必须使用 HTTP 或 HTTPS。');
    } catch { return issue('请填写完整的接口地址。'); }
    for (const { key, label, min, max } of serviceNumberFields) {
      if (!Number.isFinite(service[key]) || service[key] < min || service[key] > max) return issue(`${label}应在 ${min} 到 ${max} 之间。`);
    }
  }
  return undefined;
}

export function clearSubmittedKeys(draft: SaveSettingsPayload): SaveSettingsPayload {
  return { ...draft, translationServices: draft.translationServices.map((service) => ({ ...service, apiKey: '', clearApiKey: false })) };
}
