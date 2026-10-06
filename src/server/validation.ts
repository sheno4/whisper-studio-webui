import type {
  CreateTaskOptions,
  DownloadBehavior,
  LogLevel,
  SaveSettingsPayload,
  TranscriptionEngine,
  TranscriptionLanguage,
  TranslationServiceInput,
  VideoQualityOption
} from '../shared/types';

const transcriptionEngines = new Set<TranscriptionEngine>(['whisper', 'faster-whisper']);
const transcriptionLanguages = new Set<TranscriptionLanguage>([
  'auto', 'zh', 'en', 'yue', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt',
  'it', 'ar', 'hi', 'th', 'vi', 'id', 'tr', 'pl', 'nl', 'uk'
]);
const downloadBehaviors = new Set<DownloadBehavior>(['transcribe', 'downloadOnly', 'downloadThenTranscribe']);
const videoQualities = new Set<VideoQualityOption>(['best', '1080p', '720p', '480p', 'audio']);
const logLevels = new Set<LogLevel>(['debug', 'info', 'warning', 'error']);

export class RequestValidationError extends Error {
  readonly status = 400;
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestValidationError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
};

const requiredString = (record: Record<string, unknown>, key: string, maxLength = 4096): string => {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new RequestValidationError(`${key} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new RequestValidationError(`${key} is too long.`);
  }
  return value.trim();
};

const optionalString = (record: Record<string, unknown>, key: string, maxLength = 4096): string | undefined => {
  const value = record[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new RequestValidationError(`${key} must be a string.`);
  }
  return value.trim() || undefined;
};

const requiredBoolean = (record: Record<string, unknown>, key: string): boolean => {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new RequestValidationError(`${key} must be a boolean.`);
  }
  return value;
};

const requiredNumber = (
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RequestValidationError(`${key} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
};

const optionalInteger = (
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  if (record[key] === undefined) return fallback;
  const value = requiredNumber(record, key, minimum, maximum);
  if (!Number.isInteger(value)) {
    throw new RequestValidationError(`${key} must be a whole number.`);
  }
  return value;
};

const parseTranslationServices = (value: unknown): TranslationServiceInput[] => {
  if (!Array.isArray(value) || value.length > 50) {
    throw new RequestValidationError('translationServices must be an array with at most 50 items.');
  }

  const services = value.map((item) => {
    const service = asRecord(item);
    const id = requiredString(service, 'id', 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new RequestValidationError('Translation service id contains unsupported characters.');
    }

    const apiUrl = requiredString(service, 'apiUrl', 2048).replace(/\/+$/, '');
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(apiUrl);
    } catch {
      throw new RequestValidationError('Translation service apiUrl must be a valid URL.');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new RequestValidationError('Translation service apiUrl must use HTTP or HTTPS.');
    }

    return {
      id,
      name: requiredString(service, 'name', 128),
      enabled: requiredBoolean(service, 'enabled'),
      apiUrl,
      model: requiredString(service, 'model', 256),
      customContent: optionalString(service, 'customContent', 10000) || '',
      enableAiContext: requiredBoolean(service, 'enableAiContext'),
      systemPrompt: optionalString(service, 'systemPrompt', 20000) || '',
      multiplePrompt: optionalString(service, 'multiplePrompt', 20000) || '',
      prompt: optionalString(service, 'prompt', 20000) || '',
      requestLimit: requiredNumber(service, 'requestLimit', 0.1, 100),
      maxTextLengthPerRequest: requiredNumber(service, 'maxTextLengthPerRequest', 100, 100000),
      maxTextGroupLengthPerRequest: requiredNumber(service, 'maxTextGroupLengthPerRequest', 1, 200),
      enableRichTranslate: requiredBoolean(service, 'enableRichTranslate'),
      maxTextGroupLengthPerRequestForSubtitle: requiredNumber(
        service,
        'maxTextGroupLengthPerRequestForSubtitle',
        1,
        200
      ),
      subtitlePrompt: optionalString(service, 'subtitlePrompt', 20000) || '',
      temperature: requiredNumber(service, 'temperature', 0, 2),
      apiKey: optionalString(service, 'apiKey', 4096),
      clearApiKey: service.clearApiKey === true
    };
  });

  if (new Set(services.map((service) => service.id)).size !== services.length) {
    throw new RequestValidationError('Translation service ids must be unique.');
  }

  return services;
};

export const parseTranslationService = (value: unknown): TranslationServiceInput => {
  return parseTranslationServices([value])[0];
};

export const parseStringArray = (value: unknown, label: string, maximum = 100): string[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RequestValidationError(`${label} must be an array with at most ${maximum} items.`);
  }
  const result = value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.length > 8192) {
      throw new RequestValidationError(`${label} contains an invalid value.`);
    }
    return item.trim();
  });
  return result;
};

export const parseCreateTaskOptions = (value: unknown): CreateTaskOptions => {
  if (value === undefined || value === null) {
    return {};
  }
  const record = asRecord(value);
  const options: CreateTaskOptions = {};

  if (record.translateToChinese !== undefined) {
    if (typeof record.translateToChinese !== 'boolean') {
      throw new RequestValidationError('translateToChinese must be a boolean.');
    }
    options.translateToChinese = record.translateToChinese;
  }
  if (record.downloadBehavior !== undefined) {
    if (!downloadBehaviors.has(record.downloadBehavior as DownloadBehavior)) {
      throw new RequestValidationError('downloadBehavior is invalid.');
    }
    options.downloadBehavior = record.downloadBehavior as DownloadBehavior;
  }
  if (record.videoQuality !== undefined) {
    if (!videoQualities.has(record.videoQuality as VideoQualityOption)) {
      throw new RequestValidationError('videoQuality is invalid.');
    }
    options.videoQuality = record.videoQuality as VideoQualityOption;
  }
  if (record.transcriptionLanguage !== undefined) {
    if (!transcriptionLanguages.has(record.transcriptionLanguage as TranscriptionLanguage)) {
      throw new RequestValidationError('transcriptionLanguage is invalid.');
    }
    options.transcriptionLanguage = record.transcriptionLanguage as TranscriptionLanguage;
  }
  return options;
};

export const parseSaveSettings = (value: unknown): SaveSettingsPayload => {
  const record = asRecord(value);
  const youtubeCookieSource = optionalString(record, 'youtubeCookieSource', 16) ?? 'auto';
  if (!['auto', 'firefox', 'chrome', 'file', 'none'].includes(youtubeCookieSource)) {
    throw new RequestValidationError('youtubeCookieSource is invalid.');
  }

  const transcriptionEngine = requiredString(record, 'transcriptionEngine', 64) as TranscriptionEngine;
  const logLevel = requiredString(record, 'logLevel', 32) as LogLevel;
  const translationServices = parseTranslationServices(record.translationServices);
  const activeTranslationServiceId = optionalString(record, 'activeTranslationServiceId', 64);

  if (!transcriptionEngines.has(transcriptionEngine)) {
    throw new RequestValidationError('transcriptionEngine is invalid.');
  }
  if (!logLevels.has(logLevel)) {
    throw new RequestValidationError('logLevel is invalid.');
  }

  if (
    activeTranslationServiceId &&
    !translationServices.some((service) => service.id === activeTranslationServiceId && service.enabled)
  ) {
    throw new RequestValidationError('activeTranslationServiceId must reference an enabled translation service.');
  }

  return {
    youtubeCookieSource: youtubeCookieSource as SaveSettingsPayload['youtubeCookieSource'],
    youtubeBrowserProfile: optionalString(record, 'youtubeBrowserProfile'),
    maxConcurrentDownloads: optionalInteger(record, 'maxConcurrentDownloads', 3, 1, 6),
    maxConcurrentTranscriptions: optionalInteger(record, 'maxConcurrentTranscriptions', 1, 1, 2),
    maxConcurrentTranslations: optionalInteger(record, 'maxConcurrentTranslations', 2, 1, 4),
    downloadConnections: optionalInteger(record, 'downloadConnections', 8, 1, 16),
    pythonPath: requiredString(record, 'pythonPath'),
    outputDir: requiredString(record, 'outputDir'),
    whisperModel: requiredString(record, 'whisperModel', 128),
    transcriptionEngine,
    wallpaperPath: optionalString(record, 'wallpaperPath'),
    translateByDefault: requiredBoolean(record, 'translateByDefault'),
    translationServices,
    activeTranslationServiceId,
    keepAudio: requiredBoolean(record, 'keepAudio'),
    logLevel,
    debugMode: requiredBoolean(record, 'debugMode')
  };
};

export const parseActiveTranslationService = (value: unknown): string => {
  const record = asRecord(value);
  const serviceId = requiredString(record, 'serviceId', 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(serviceId)) {
    throw new RequestValidationError('serviceId is invalid.');
  }
  return serviceId;
};
