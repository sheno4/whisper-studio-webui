export type TaskStatus =
  | 'queued'
  | 'downloading'
  | 'preprocessing'
  | 'transcribing'
  | 'translating'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partial';

export type TaskSourceType = 'link' | 'file';
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';
export type ApiKeySource = 'env' | 'stored' | 'none';
export type TranscriptionEngine = 'whisper' | 'faster-whisper';
export type TranscriptionLanguage =
  | 'auto'
  | 'zh'
  | 'en'
  | 'yue'
  | 'ja'
  | 'ko'
  | 'es'
  | 'fr'
  | 'de'
  | 'ru'
  | 'pt'
  | 'it'
  | 'ar'
  | 'hi'
  | 'th'
  | 'vi'
  | 'id'
  | 'tr'
  | 'pl'
  | 'nl'
  | 'uk';
export type DownloadBehavior = 'transcribe' | 'downloadOnly' | 'downloadThenTranscribe';
export type VideoQualityOption = 'best' | '1080p' | '720p' | '480p' | 'audio';
export type ExportFileKind =
  | 'transcriptTxt'
  | 'transcriptSrt'
  | 'transcriptVtt'
  | 'transcriptJson'
  | 'translationTxt'
  | 'translationSrt'
  | 'translationVtt'
  | 'translationJson';

export interface TaskLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface TaskMediaInfo {
  extractor?: string;
  webpageUrl?: string;
  durationSeconds?: number;
  requestedQuality: VideoQualityOption;
  downloadBehavior: DownloadBehavior;
  downloadedKind?: 'video' | 'audio';
  downloadedExt?: string;
  qualityFallbackMessage?: string;
}

export interface TaskOutputFiles {
  transcriptTxt?: string;
  transcriptSrt?: string;
  transcriptVtt?: string;
  transcriptJson?: string;
  translationTxt?: string;
  translationSrt?: string;
  translationVtt?: string;
  translationJson?: string;
  audio?: string;
  downloadedMedia?: string;
  sourceMedia?: string;
  logFile?: string;
  metadataJson?: string;
}

export interface TaskRecord {
  id: string;
  sourceType: TaskSourceType;
  input: string;
  displayName: string;
  status: TaskStatus;
  progressPercent?: number;
  progressMessage: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  translateToChinese: boolean;
  downloadBehavior: DownloadBehavior;
  videoQuality: VideoQualityOption;
  transcriptionLanguage: TranscriptionLanguage;
  language?: string;
  transcriptText?: string;
  translationText?: string;
  transcriptSegments?: TranscriptSegment[];
  translationSegments?: TranscriptSegment[];
  mediaInfo?: TaskMediaInfo;
  outputDir?: string;
  outputFiles: TaskOutputFiles;
  error?: string;
  errorCode?: string;
  warning?: string;
  logs: TaskLogEntry[];
}

export interface HistoryRecord {
  id: string;
  displayName: string;
  sourceType: TaskSourceType;
  createdAt: string;
  finishedAt: string;
  status: Extract<TaskStatus, 'completed' | 'failed' | 'partial' | 'cancelled'>;
  downloadBehavior?: DownloadBehavior;
  videoQuality?: VideoQualityOption;
  translateToChinese?: boolean;
  transcriptionLanguage?: TranscriptionLanguage;
  durationSeconds?: number;
  language?: string;
  outputDir?: string;
  error?: string;
}

export interface EnvironmentCheckItem {
  key: string;
  label: string;
  ok: boolean;
  details: string;
  suggestion?: string;
}

export interface EnvironmentStatus {
  checkedAt: string;
  items: EnvironmentCheckItem[];
  apiKeyConfigured: boolean;
}

export interface TranslationServiceData {
  id: string;
  name: string;
  enabled: boolean;
  apiUrl: string;
  model: string;
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
  apiKeyConfigured: boolean;
  apiKeySource: ApiKeySource;
}

export interface TranslationServiceInput extends Omit<TranslationServiceData, 'apiKeyConfigured' | 'apiKeySource'> {
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface TranslationServiceTestResult {
  ok: true;
  mode: 'responses' | 'chat';
  endpoint: string;
  latencyMs: number;
  responsePreview: string;
}

export interface SettingsData {
  maxConcurrentDownloads?: number;
  maxConcurrentTranscriptions?: number;
  maxConcurrentTranslations?: number;
  downloadConnections?: number;
  youtubeCookieSource?: 'auto' | 'firefox' | 'chrome' | 'file' | 'none';
  youtubeBrowserProfile?: string;
  pythonPath: string;
  outputDir: string;
  whisperModel: string;
  transcriptionEngine: TranscriptionEngine;
  wallpaperPath?: string;
  translateByDefault: boolean;
  translationServices: TranslationServiceData[];
  activeTranslationServiceId?: string;
  keepAudio: boolean;
  logLevel: LogLevel;
  debugMode: boolean;
}

export interface SaveSettingsPayload {
  maxConcurrentDownloads?: number;
  maxConcurrentTranscriptions?: number;
  maxConcurrentTranslations?: number;
  downloadConnections?: number;
  youtubeCookieSource?: 'auto' | 'firefox' | 'chrome' | 'file' | 'none';
  youtubeBrowserProfile?: string;
  pythonPath: string;
  outputDir: string;
  whisperModel: string;
  transcriptionEngine: TranscriptionEngine;
  wallpaperPath?: string;
  translateByDefault: boolean;
  translationServices: TranslationServiceInput[];
  activeTranslationServiceId?: string;
  keepAudio: boolean;
  logLevel: LogLevel;
  debugMode: boolean;
}

export interface CreateTaskOptions {
  translateToChinese?: boolean;
  downloadBehavior?: DownloadBehavior;
  videoQuality?: VideoQualityOption;
  transcriptionLanguage?: TranscriptionLanguage;
}

export interface WorkerTaskRequest {
  phase?: 'prepare' | 'transcribe';
  preparedMedia?: PreparedMediaPayload;
  downloadConnections?: number;
  youtubeCookieSource?: 'auto' | 'firefox' | 'chrome' | 'file' | 'none';
  youtubeBrowserProfile?: string;
  taskId: string;
  sourceType: TaskSourceType;
  input: string;
  displayName: string;
  outputDir: string;
  whisperModel: string;
  transcriptionEngine: TranscriptionEngine;
  keepAudio: boolean;
  logLevel: LogLevel;
  downloadBehavior: DownloadBehavior;
  videoQuality: VideoQualityOption;
  transcriptionLanguage?: Exclude<TranscriptionLanguage, 'auto'>;
  projectRoot: string;
}

export interface WorkerProgressEvent {
  type: 'progress';
  status: TaskStatus;
  message: string;
  percent?: number;
}

export interface WorkerLogEvent {
  type: 'log';
  level: LogLevel;
  message: string;
  context?: string;
}

export interface WorkerMetadataEvent {
  type: 'metadata';
  displayName?: string;
  outputDir?: string;
}

export interface WorkerErrorEvent {
  type: 'error';
  code: string;
  message: string;
  details?: string;
}

export interface PreparedMediaPayload {
  transcriptInputPath?: string | null;
  tempAudioPath?: string | null;
  downloadedMediaPath?: string | null;
  sourceMediaPath?: string | null;
  mediaInfo: TaskMediaInfo;
}

export interface WorkerResultPayload {
  preparedMedia?: PreparedMediaPayload;
  taskId: string;
  sourceType: TaskSourceType;
  input: string;
  displayName: string;
  outputDir: string;
  mediaInfo?: TaskMediaInfo;
  language?: string;
  transcriptText: string;
  transcriptSegments: TranscriptSegment[];
  outputFiles: TaskOutputFiles;
}

export interface WorkerResultEvent {
  type: 'result';
  data: WorkerResultPayload;
}

export type WorkerEvent =
  | WorkerProgressEvent
  | WorkerLogEvent
  | WorkerMetadataEvent
  | WorkerErrorEvent
  | WorkerResultEvent;

export interface AppSnapshot {
  settings: SettingsData;
  tasks: TaskRecord[];
  history: HistoryRecord[];
  environment: EnvironmentStatus;
}

export interface ToastEvent {
  id: string;
  title: string;
  message: string;
  tone: 'info' | 'success' | 'warning' | 'error';
}
