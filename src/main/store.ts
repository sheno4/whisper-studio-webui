import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_TRANSCRIPTION_ENGINE,
  DEFAULT_WHISPER_MODEL
} from '../shared/constants';
import type {
  ApiKeySource,
  HistoryRecord,
  SaveSettingsPayload,
  SettingsData,
  TranslationServiceData,
  TranslationServiceInput
} from '../shared/types';
import {
  getDataDir,
  getDefaultOutputDir,
  getDefaultPythonPath,
  resolveStoredRuntimePaths
} from './paths';

type PersistedTranslationService = Omit<TranslationServiceData, 'apiKeyConfigured' | 'apiKeySource'>;
type PersistedSettings = Omit<SettingsData, 'translationServices'> & {
  translationServices: PersistedTranslationService[];
};

interface AppStoreSchema {
  settings: PersistedSettings;
  history: HistoryRecord[];
  encryptedApiKeys: Record<string, string>;
}

interface RawStoreSchema {
  settings?: Record<string, unknown>;
  history?: unknown;
  encryptedApiKeys?: unknown;
}

const storePath = path.join(getDataDir(), 'settings.json');
const keyPath = path.join(getDataDir(), 'secret.key');

const createDefaultSettings = (): PersistedSettings => ({
  maxConcurrentDownloads: 3,
  maxConcurrentTranscriptions: 1,
  maxConcurrentTranslations: 2,
  downloadConnections: 8,
  pythonPath: getDefaultPythonPath(),
  outputDir: getDefaultOutputDir(),
  whisperModel: DEFAULT_WHISPER_MODEL,
  transcriptionEngine: DEFAULT_TRANSCRIPTION_ENGINE,
  wallpaperPath: undefined,
  translateByDefault: false,
  translationServices: [],
  activeTranslationServiceId: undefined,
  keepAudio: true,
  logLevel: DEFAULT_LOG_LEVEL,
  debugMode: false
});

const ensureDataDir = (): void => {
  fs.mkdirSync(getDataDir(), { recursive: true });
};

function writeStore(store: AppStoreSchema): void {
  ensureDataDir();
  const temporaryPath = `${storePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, storePath);
}

const storedString = (value: unknown, fallback: string): string => {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
};

const storedOptionalString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const storedBoolean = (value: unknown, fallback: boolean): boolean => {
  return typeof value === 'boolean' ? value : fallback;
};

const storedNumber = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
};

const storedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  return typeof value === 'number' && Number.isInteger(value)
    ? storedNumber(value, fallback, minimum, maximum)
    : fallback;
};

const normalizePersistedService = (value: unknown): PersistedTranslationService | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const service = value as Record<string, unknown>;
  const id = storedOptionalString(service.id);
  const name = storedOptionalString(service.name);
  const apiUrl = storedOptionalString(service.apiUrl);
  const model = storedOptionalString(service.model);
  if (!id || !name || !apiUrl || !model) {
    return undefined;
  }

  return {
    id,
    name,
    enabled: storedBoolean(service.enabled, true),
    apiUrl,
    model,
    customContent: typeof service.customContent === 'string' ? service.customContent : '',
    enableAiContext: storedBoolean(service.enableAiContext, false),
    systemPrompt: typeof service.systemPrompt === 'string' ? service.systemPrompt : '',
    multiplePrompt: typeof service.multiplePrompt === 'string' ? service.multiplePrompt : '',
    prompt: typeof service.prompt === 'string' ? service.prompt : '',
    requestLimit: storedNumber(service.requestLimit, 2, 0.1, 100),
    maxTextLengthPerRequest: storedNumber(service.maxTextLengthPerRequest, 3600, 100, 100000),
    maxTextGroupLengthPerRequest: storedNumber(service.maxTextGroupLengthPerRequest, 18, 1, 200),
    enableRichTranslate: storedBoolean(service.enableRichTranslate, false),
    maxTextGroupLengthPerRequestForSubtitle: storedNumber(
      service.maxTextGroupLengthPerRequestForSubtitle,
      18,
      1,
      200
    ),
    subtitlePrompt: typeof service.subtitlePrompt === 'string' ? service.subtitlePrompt : '',
    temperature: storedNumber(service.temperature, 0.2, 0, 2)
  };
};

const normalizeSettings = (raw: Record<string, unknown> | undefined): PersistedSettings => {
  const defaults = createDefaultSettings();
  const services = Array.isArray(raw?.translationServices)
    ? raw.translationServices
        .map(normalizePersistedService)
        .filter((service): service is PersistedTranslationService => Boolean(service))
        .filter((service, index, all) => all.findIndex((candidate) => candidate.id === service.id) === index)
        .slice(0, 50)
    : [];
  const requestedActiveId = storedOptionalString(raw?.activeTranslationServiceId);
  const activeTranslationServiceId = services.some(
    (service) => service.id === requestedActiveId && service.enabled
  )
    ? requestedActiveId
    : services.find((service) => service.enabled)?.id;

  return {
    ...resolveStoredRuntimePaths({
      pythonPath: storedString(raw?.pythonPath, defaults.pythonPath),
      outputDir: storedString(raw?.outputDir, defaults.outputDir)
    }),
    maxConcurrentDownloads: storedInteger(raw?.maxConcurrentDownloads, 3, 1, 6),
    maxConcurrentTranscriptions: storedInteger(raw?.maxConcurrentTranscriptions, 1, 1, 2),
    maxConcurrentTranslations: storedInteger(raw?.maxConcurrentTranslations, 2, 1, 4),
    downloadConnections: storedInteger(raw?.downloadConnections, 8, 1, 16),
    youtubeCookieSource: typeof raw?.youtubeCookieSource === 'string' && ['auto', 'firefox', 'chrome', 'file', 'none'].includes(raw.youtubeCookieSource)
      ? raw.youtubeCookieSource as SettingsData['youtubeCookieSource'] : 'auto',
    youtubeBrowserProfile: storedOptionalString(raw?.youtubeBrowserProfile),
    whisperModel: storedString(raw?.whisperModel, defaults.whisperModel),
    transcriptionEngine: raw?.transcriptionEngine === 'whisper' ? 'whisper' : 'faster-whisper',
    wallpaperPath: storedOptionalString(raw?.wallpaperPath),
    translateByDefault: storedBoolean(raw?.translateByDefault, defaults.translateByDefault),
    translationServices: services,
    activeTranslationServiceId,
    keepAudio: storedBoolean(raw?.keepAudio, defaults.keepAudio),
    logLevel: raw?.logLevel === 'debug' || raw?.logLevel === 'warning' || raw?.logLevel === 'error'
      ? raw.logLevel
      : 'info',
    debugMode: storedBoolean(raw?.debugMode, defaults.debugMode)
  };
};

const readStore = (): AppStoreSchema => {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as RawStoreSchema;
    const settings = normalizeSettings(parsed.settings);
    const serviceIds = new Set(settings.translationServices.map((service) => service.id));
    const encryptedApiKeys = parsed.encryptedApiKeys && typeof parsed.encryptedApiKeys === 'object'
      ? Object.fromEntries(
          Object.entries(parsed.encryptedApiKeys as Record<string, unknown>).filter(
            (entry): entry is [string, string] => serviceIds.has(entry[0]) && typeof entry[1] === 'string'
          )
        )
      : {};
    const store: AppStoreSchema = {
      settings,
      history: Array.isArray(parsed.history) ? parsed.history as HistoryRecord[] : [],
      encryptedApiKeys
    };

    return store;
  } catch {
    return {
      settings: createDefaultSettings(),
      history: [],
      encryptedApiKeys: {}
    };
  }
};

const readOrCreateEncryptionKey = (): Buffer => {
  ensureDataDir();
  try {
    const key = fs.readFileSync(keyPath);
    if (key.length === 32) {
      return key;
    }
  } catch {
    // A new per-installation key is created below.
  }

  const key = randomBytes(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'w' });
  return key;
};

const encryptApiKey = (value: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', readOrCreateEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
};

const decryptApiKey = (value: string): string | undefined => {
  try {
    const [version, encodedIv, encodedTag, encodedValue] = value.split(':');
    if (version !== 'v1' || !encodedIv || !encodedTag || !encodedValue) {
      return undefined;
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      readOrCreateEncryptionKey(),
      Buffer.from(encodedIv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedValue, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    return undefined;
  }
};

const normalizeOptional = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const looksGarbledText = (value?: string): boolean => {
  return Boolean(value && (value.match(/�/g)?.length ?? 0) >= 2);
};

const fallbackHistoryName = (record: HistoryRecord): string => {
  if (!record.outputDir) {
    return record.sourceType === 'file' ? '本地文件任务' : '链接任务';
  }
  return record.outputDir.split(/[\\/]/).filter(Boolean).at(-1) || '任务';
};

const normalizeHistoryRecord = (record: HistoryRecord): HistoryRecord => {
  return looksGarbledText(record.displayName)
    ? { ...record, displayName: fallbackHistoryName(record) }
    : record;
};

const sortHistoryNewestFirst = (history: HistoryRecord[]): HistoryRecord[] => {
  return [...history].sort((left, right) => {
    const leftTime = Date.parse(left.finishedAt);
    const rightTime = Date.parse(right.finishedAt);
    const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
    const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
    return safeRight - safeLeft;
  });
};

const resolveApiKeyState = (store: AppStoreSchema, serviceId: string): {
  configured: boolean;
  source: ApiKeySource;
} => {
  const encrypted = store.encryptedApiKeys[serviceId];
  return encrypted && decryptApiKey(encrypted)
    ? { configured: true, source: 'stored' }
    : { configured: false, source: 'none' };
};

const toSettingsView = (store: AppStoreSchema): SettingsData => ({
  ...store.settings,
  ...resolveStoredRuntimePaths(store.settings),
  translationServices: store.settings.translationServices.map((service) => {
    const apiKeyState = resolveApiKeyState(store, service.id);
    return {
      ...service,
      apiKeyConfigured: apiKeyState.configured,
      apiKeySource: apiKeyState.source
    };
  })
});

const toPersistedService = (service: TranslationServiceInput): PersistedTranslationService => ({
  id: service.id.trim(),
  name: service.name.trim(),
  enabled: service.enabled,
  apiUrl: service.apiUrl.trim().replace(/\/+$/, ''),
  model: service.model.trim(),
  customContent: service.customContent.trim(),
  enableAiContext: service.enableAiContext,
  systemPrompt: service.systemPrompt.trim(),
  multiplePrompt: service.multiplePrompt.trim(),
  prompt: service.prompt.trim(),
  requestLimit: service.requestLimit,
  maxTextLengthPerRequest: service.maxTextLengthPerRequest,
  maxTextGroupLengthPerRequest: service.maxTextGroupLengthPerRequest,
  enableRichTranslate: service.enableRichTranslate,
  maxTextGroupLengthPerRequestForSubtitle: service.maxTextGroupLengthPerRequestForSubtitle,
  subtitlePrompt: service.subtitlePrompt.trim(),
  temperature: service.temperature
});

export const getSettingsView = (): SettingsData => toSettingsView(readStore());

export const saveSettingsView = (payload: SaveSettingsPayload): SettingsData => {
  const store = readStore();
  const services = payload.translationServices.map(toPersistedService);
  const serviceIds = new Set(services.map((service) => service.id));
  const encryptedApiKeys = Object.fromEntries(
    Object.entries(store.encryptedApiKeys).filter(([serviceId]) => serviceIds.has(serviceId))
  );

  for (const service of payload.translationServices) {
    if (service.clearApiKey) {
      delete encryptedApiKeys[service.id];
    } else if (service.apiKey?.trim()) {
      encryptedApiKeys[service.id] = encryptApiKey(service.apiKey.trim());
    }
  }

  store.settings = {
    maxConcurrentDownloads: storedInteger(payload.maxConcurrentDownloads, 3, 1, 6),
    maxConcurrentTranscriptions: storedInteger(payload.maxConcurrentTranscriptions, 1, 1, 2),
    maxConcurrentTranslations: storedInteger(payload.maxConcurrentTranslations, 2, 1, 4),
    downloadConnections: storedInteger(payload.downloadConnections, 8, 1, 16),
    youtubeCookieSource: payload.youtubeCookieSource ?? 'auto',
    youtubeBrowserProfile: normalizeOptional(payload.youtubeBrowserProfile),
    pythonPath: payload.pythonPath.trim(),
    outputDir: path.resolve(payload.outputDir.trim()),
    whisperModel: payload.whisperModel.trim(),
    transcriptionEngine: payload.transcriptionEngine,
    wallpaperPath: normalizeOptional(payload.wallpaperPath),
    translateByDefault: payload.translateByDefault,
    translationServices: services,
    activeTranslationServiceId: payload.activeTranslationServiceId,
    keepAudio: payload.keepAudio,
    logLevel: payload.logLevel,
    debugMode: payload.debugMode
  };
  store.encryptedApiKeys = encryptedApiKeys;

  writeStore(store);
  return toSettingsView(store);
};

export const saveActiveTranslationServiceView = (serviceId: string): SettingsData => {
  const store = readStore();
  const service = store.settings.translationServices.find(
    (candidate) => candidate.id === serviceId && candidate.enabled
  );
  if (!service) {
    throw new Error('翻译服务不存在或尚未启用。');
  }
  store.settings.activeTranslationServiceId = serviceId;
  writeStore(store);
  return toSettingsView(store);
};

export const getTranslationServiceApiKey = (serviceId: string): { value?: string; source: ApiKeySource } => {
  const encrypted = readStore().encryptedApiKeys[serviceId];
  const value = encrypted ? decryptApiKey(encrypted) : undefined;
  return value ? { value, source: 'stored' } : { source: 'none' };
};

export const getHistoryRecords = (): HistoryRecord[] => {
  return sortHistoryNewestFirst(readStore().history.map(normalizeHistoryRecord));
};

export const saveHistoryRecords = (history: HistoryRecord[]): void => {
  const store = readStore();
  store.history = sortHistoryNewestFirst(history.map(normalizeHistoryRecord)).slice(0, 50);
  writeStore(store);
};
