import type {
  AppSnapshot,
  CreateTaskOptions,
  ExportFileKind,
  SaveSettingsPayload,
  SettingsData,
  TaskRecord,
  ToastEvent,
  TranslationServiceInput,
  TranslationServiceTestResult
} from './types';

export interface WhisperWebApi {
  getSnapshot: () => Promise<AppSnapshot>;
  getSettings: () => Promise<SettingsData>;
  uploadFiles: (files: object[]) => Promise<string[]>;
  addLinkTasks: (links: string[], options?: CreateTaskOptions) => Promise<TaskRecord[]>;
  addFileTasks: (paths: string[], options?: CreateTaskOptions) => Promise<TaskRecord[]>;
  retryTask: (taskId: string) => Promise<boolean>;
  cancelTask: (taskId: string) => Promise<boolean>;
  removeTask: (taskId: string) => Promise<boolean>;
  deleteTaskDirectory: (taskId: string) => Promise<boolean>;
  openOutputDir: (taskId: string) => Promise<boolean>;
  openSourceLocation: (taskId: string) => Promise<boolean>;
  exportTaskFile: (
    taskId: string,
    kind: ExportFileKind
  ) => Promise<boolean>;
  pickFiles: () => Promise<string[]>;
  pickWallpaperFile: () => Promise<string | null>;
  pickDirectory: () => Promise<string | null>;
  saveSettings: (payload: SaveSettingsPayload) => Promise<SettingsData>;
  setActiveTranslationService: (serviceId: string) => Promise<SettingsData>;
  testTranslationService: (service: TranslationServiceInput) => Promise<TranslationServiceTestResult>;
  clearHistory: () => Promise<void>;
  removeHistoryItem: (historyId: string) => Promise<boolean>;
  revealPath: (targetPath: string) => Promise<boolean>;
  onState: (listener: (snapshot: AppSnapshot) => void) => () => void;
  onToast: (listener: (toast: ToastEvent) => void) => () => void;
}
