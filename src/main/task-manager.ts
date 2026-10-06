import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { getRuntimeEnv } from '../../scripts/runtime-env.cjs';

import { extractLinksFromInputs, isDouyinLink, normalizeLinkCandidate } from '../shared/link-parser';
import type {
  AppSnapshot,
  CreateTaskOptions,
  DownloadBehavior,
  EnvironmentStatus,
  ExportFileKind,
  HistoryRecord,
  ModelPreparationState,
  SaveSettingsPayload,
  SettingsData,
  TaskLogEntry,
  TaskRecord,
  TaskSourceType,
  TranslationServiceInput,
  TranslationServiceTestResult,
  VideoQualityOption,
  WorkerEvent,
  WorkerResultPayload,
  WorkerTaskRequest,
  ToastEvent
} from '../shared/types';
import { probeOutputDirectory, runEnvironmentCheck } from './environment';
import { writeAppLog } from './logger';
import {
  testTranslationServiceConnection,
  translateSegmentsToChinese,
  TranslationError
} from './translation-client';
import { getProjectRoot, getUploadsDir, getWorkerScriptPath, resolveStoredRuntimePaths } from './paths';
import { TaskSlotLimiter } from './concurrency';
import { PythonWorkerClient } from './python-worker';
import { ModelPreparationManager } from './model-preparation';
import { openLocalPath, revealLocalPath } from './system';
import {
  getHistoryRecords,
  getTranslationServiceApiKey,
  getSettingsView,
  saveActiveTranslationServiceView,
  saveHistoryRecords,
  saveSettingsView
} from './store';

class CancelledTaskError extends Error {
  constructor() {
    super('Task cancelled');
    this.name = 'CancelledTaskError';
  }
}

const DEFAULT_DOWNLOAD_BEHAVIOR: DownloadBehavior = 'transcribe';
const DEFAULT_VIDEO_QUALITY: VideoQualityOption = 'best';

const sanitizeForPath = (value: string): string => {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
};

const looksGarbledText = (value?: string): boolean => {
  if (!value) {
    return false;
  }

  return (value.match(/锟/g)?.length ?? 0) >= 2;
};

const buildPythonEnv = (): NodeJS.ProcessEnv => ({
  ...getRuntimeEnv(getProjectRoot()),
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
  OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || String(Math.min(8, availableParallelism())),
  MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || String(Math.min(8, availableParallelism()))
});

const pickDisplayName = (input: string, sourceType: 'link' | 'file'): string => {
  if (sourceType === 'file') {
    const name = path.parse(input).name;
    const relative = path.relative(path.resolve(getUploadsDir()), path.resolve(input));
    const isUploadedFile = Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
    return isUploadedFile
      ? name.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '')
      : name;
  }

  try {
    const url = new URL(input);
    return `${url.hostname}${url.pathname}`.slice(0, 80);
  } catch {
    return input.slice(0, 80);
  }
};

const isTaskActiveStatus = (status: TaskRecord['status']): boolean => {
  return ['queued', 'downloading', 'preprocessing', 'transcribing', 'translating'].includes(status);
};

const WORKING_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class TaskManager {
  private readonly tasks: TaskRecord[] = [];
  private history: HistoryRecord[] = getHistoryRecords();
  private settings: SettingsData = getSettingsView();
  private environment: EnvironmentStatus = {
    checkedAt: new Date().toISOString(),
    items: [],
    apiKeyConfigured: Boolean(
      this.settings.translationServices.find(
        (service) => service.id === this.settings.activeTranslationServiceId
      )?.apiKeyConfigured
    )
  };
  private isProcessing = false;
  private readonly taskControllers = new Map<string, AbortController>();
  private readonly runningTasks = new Map<string, Promise<void>>();
  private queueDrain?: Promise<void>;
  private wakeQueueDrain?: () => void;
  private shuttingDown = false;
  private readonly downloadSlots = new TaskSlotLimiter(this.settings.maxConcurrentDownloads ?? 3);
  private readonly transcriptionSlots = new TaskSlotLimiter(this.settings.maxConcurrentTranscriptions ?? 1);
  private readonly translationSlots = new TaskSlotLimiter(this.settings.maxConcurrentTranslations ?? 2);
  private readonly outputFinalizationSlot = new TaskSlotLimiter(1);
  private readonly preparationWorkers = new Set<PythonWorkerClient>();
  private readonly transcriptionWorkers: Array<{ client: PythonWorkerClient; busy: boolean; pythonPath: string; engine: SettingsData['transcriptionEngine'] }> = [];
  private cancellingTaskIds = new Set<string>();
  private stateBroadcastTimer?: NodeJS.Timeout;
  private readonly stateListeners = new Set<(snapshot: AppSnapshot) => void>();
  private readonly toastListeners = new Set<(toast: ToastEvent) => void>();
  private readonly modelPreparation = new ModelPreparationManager({
    projectRoot: getProjectRoot(), onChange: () => this.handleModelPreparationChange()
  });
  private modelEnvironmentState = '';
  private environmentRevision = 0;

  onState(listener: (snapshot: AppSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onToast(listener: (toast: ToastEvent) => void): () => void {
    this.toastListeners.add(listener);
    return () => this.toastListeners.delete(listener);
  }

  private getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.find((item) => item.id === taskId);
  }

  private getNextQueuedTask(): TaskRecord | undefined {
    return this.tasks.find((item) => item.status === 'queued');
  }

  private getSourceLocation(task: TaskRecord): string | undefined {
    if (task.sourceType === 'file') {
      return task.input;
    }

    return task.outputFiles.downloadedMedia || task.outputFiles.audio || task.outputFiles.sourceMedia || task.outputDir;
  }

  private queueTasks(inputs: string[], sourceType: TaskSourceType, options?: CreateTaskOptions): TaskRecord[] {
    const created = inputs.map((value) => this.createTaskRecord(value, sourceType, options));
    this.tasks.push(...created);
    this.broadcastState();
    void this.processQueue();
    return created;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.settings.outputDir, { recursive: true });
    await this.cleanupStorage();
    if (process.env.WHISPER_SKIP_MODEL_PREFETCH !== '1') this.prepareModel();
    const settings = this.settings;
    const revision = ++this.environmentRevision;
    const environment = await runEnvironmentCheck(settings);
    if (revision === this.environmentRevision && settings === this.settings && !this.shuttingDown) this.environment = environment;
    this.flushStateBroadcast();
  }

  getSnapshot(): AppSnapshot {
    return {
      settings: this.settings,
      tasks: this.tasks,
      history: this.history,
      environment: this.environment,
      modelPreparations: this.modelPreparation.getStates()
    };
  }

  getSettings(): SettingsData {
    return this.settings;
  }

  prepareModel(): ModelPreparationState {
    return { ...this.modelPreparation.prepare(this.settings, true).state };
  }

  cancelModelPreparation(id: string): boolean {
    return this.modelPreparation.cancel(id);
  }

  private handleModelPreparationChange(): void {
    this.broadcastState();
    const model = this.settings.transcriptionEngine === 'whisper.cpp'
      ? ({ turbo: 'large-v3-turbo', large: 'large-v3' } as Record<string, string>)[this.settings.whisperModel] || this.settings.whisperModel
      : this.settings.whisperModel;
    const state = this.modelPreparation.getStates().find((item) => item.pythonPath === this.settings.pythonPath && item.engine === this.settings.transcriptionEngine && item.model === model);
    if (!state || !['ready', 'failed', 'cancelled'].includes(state.status)) return;
    const revision = `${state.id}:${state.status}`;
    if (revision === this.modelEnvironmentState || this.shuttingDown) return;
    this.modelEnvironmentState = revision;
    void this.refreshEnvironmentInBackground();
  }

  async saveSettings(payload: SaveSettingsPayload): Promise<SettingsData> {
    const previous = this.settings;
    const { outputDir } = resolveStoredRuntimePaths({
      pythonPath: payload.pythonPath.trim(),
      outputDir: path.resolve(payload.outputDir.trim())
    });
    await probeOutputDirectory(outputDir);
    this.settings = saveSettingsView(payload);
    if (previous.pythonPath !== this.settings.pythonPath ||
      previous.transcriptionEngine !== this.settings.transcriptionEngine ||
      previous.whisperModel !== this.settings.whisperModel) this.prepareModel();
    this.downloadSlots.setLimit(this.settings.maxConcurrentDownloads ?? 3);
    this.transcriptionSlots.setLimit(this.settings.maxConcurrentTranscriptions ?? 1);
    this.translationSlots.setLimit(this.settings.maxConcurrentTranslations ?? 2);
    void this.retireIdleWorkers();
    void this.processQueue();
    this.broadcastState();
    void this.refreshEnvironmentInBackground();
    return this.settings;
  }

  async setActiveTranslationService(serviceId: string): Promise<SettingsData> {
    this.settings = saveActiveTranslationServiceView(serviceId);
    const activeService = this.settings.translationServices.find(
      (service) => service.id === this.settings.activeTranslationServiceId
    );
    this.environment = {
      ...this.environment,
      apiKeyConfigured: Boolean(activeService?.apiKeyConfigured)
    };
    this.broadcastState();
    void this.refreshEnvironmentInBackground();
    return this.settings;
  }

  async testTranslationService(service: TranslationServiceInput): Promise<TranslationServiceTestResult> {
    const storedApiKey = getTranslationServiceApiKey(service.id);
    const submittedApiKey = service.apiKey?.trim();
    const apiKey = submittedApiKey || (service.clearApiKey ? undefined : storedApiKey.value);

    return testTranslationServiceConnection({
      apiKey,
      model: service.model,
      baseUrl: service.apiUrl,
      requestLimit: service.requestLimit,
      temperature: service.temperature
    });
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    saveHistoryRecords([]);
    this.broadcastState();
  }

  async removeHistoryItem(historyId: string): Promise<boolean> {
    const nextHistory = this.history.filter((item) => item.id !== historyId);
    if (nextHistory.length === this.history.length) {
      return false;
    }

    this.history = nextHistory;
    saveHistoryRecords(this.history);
    this.broadcastState();
    return true;
  }

  addLinkTasks(links: string[], options?: CreateTaskOptions): TaskRecord[] {
    return this.queueTasks(extractLinksFromInputs(links), 'link', options);
  }

  addFileTasks(filePaths: string[], options?: CreateTaskOptions): TaskRecord[] {
    return this.queueTasks(filePaths.map((value) => value.trim()).filter(Boolean), 'file', options);
  }

  async retryTask(taskId: string): Promise<boolean> {
    const task = this.getTask(taskId);
    if (!task || this.taskControllers.has(task.id) || !['failed', 'cancelled', 'partial'].includes(task.status)) {
      return false;
    }

    task.status = 'queued';
    task.progressPercent = 0;
    task.progressMessage = '已加入重试队列';
    task.updatedAt = new Date().toISOString();
    task.error = undefined;
    task.errorCode = undefined;
    task.warning = undefined;
    task.language = undefined;
    task.transcriptText = undefined;
    task.translationText = undefined;
    task.transcriptSegments = undefined;
    task.translationSegments = undefined;
    task.mediaInfo = undefined;
    task.outputFiles = {};
    task.outputDir = undefined;
    this.appendTaskLog(task.id, 'info', 'Task queued for retry.');
    this.broadcastState();
    void this.processQueue();
    return true;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.getTask(taskId);
    if (!task || !isTaskActiveStatus(task.status)) {
      return false;
    }

    if (!this.taskControllers.has(taskId)) {
      task.status = 'cancelled';
      task.progressMessage = '已取消';
      task.updatedAt = new Date().toISOString();
      this.finalizeHistory(task);
      this.broadcastState();
      return true;
    }

    this.cancellingTaskIds.add(taskId);
    this.taskControllers.get(taskId)?.abort();
    this.updateTask(taskId, { progressMessage: '正在取消任务' });
    return true;
  }

  async removeTask(taskId: string): Promise<boolean> {
    if (this.taskControllers.has(taskId)) {
      return false;
    }

    const index = this.tasks.findIndex((item) => item.id === taskId);
    if (index === -1) {
      return false;
    }

    const task = this.tasks[index];
    this.tasks.splice(index, 1);
    await this.removeUploadIfUnreferenced(task);
    this.broadcastState();
    return true;
  }

  private async removeUploadIfUnreferenced(task: TaskRecord): Promise<void> {
    if (task.sourceType !== 'file') {
      return;
    }

    const uploadRoot = path.resolve(getUploadsDir());
    const resolvedInput = path.resolve(task.input);
    if (!resolvedInput.startsWith(`${uploadRoot}${path.sep}`)) {
      return;
    }

    const referenced = this.tasks.some(
      (candidate) =>
        candidate.sourceType === 'file' &&
        path.resolve(candidate.input) === resolvedInput
    );
    if (!referenced) {
      await fs.rm(resolvedInput, { force: true }).catch(() => undefined);
    }
  }

  private async cleanupStorage(): Promise<void> {
    const outputRoot = path.resolve(this.settings.outputDir);
    const now = Date.now();

    await fs.mkdir(outputRoot, { recursive: true });
    try {
      const entries = await fs.readdir(outputRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('__working__-')) {
          continue;
        }

        const target = path.join(outputRoot, entry.name);
        const stat = await fs.stat(target).catch(() => null);
        if (stat && now - stat.mtimeMs > WORKING_DIR_MAX_AGE_MS) {
          await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch {
      // The output folder may not exist yet or may be unreadable.
    }

    const uploadRoot = path.resolve(getUploadsDir());
    const referencedUploads = new Set(
      this.tasks
        .filter((task) => task.sourceType === 'file')
        .map((task) => path.resolve(task.input))
    );

    try {
      const entries = await fs.readdir(uploadRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }

        const target = path.join(uploadRoot, entry.name);
        if (referencedUploads.has(path.resolve(target))) {
          continue;
        }

        const stat = await fs.stat(target).catch(() => null);
        if (stat && now - stat.mtimeMs > UPLOAD_MAX_AGE_MS) {
          await fs.rm(target, { force: true }).catch(() => undefined);
        }
      }
    } catch {
      // No uploads have been created yet.
    }
  }

  async openOutputDir(taskId: string): Promise<boolean> {
    const task = this.getTask(taskId);
    const outputDir = task?.outputDir ?? this.history.find((item) => item.id === taskId)?.outputDir;
    if (!outputDir) throw new Error('该任务没有可打开的输出目录，请刷新任务列表后重试。');
    return openLocalPath(outputDir);
  }

  async deleteTaskDirectory(recordId: string): Promise<boolean> {
    if (this.taskControllers.has(recordId)) {
      return false;
    }

    const task = this.getTask(recordId);
    const historyRecord = this.history.find((item) => item.id === recordId);
    const outputDir = task?.outputDir ?? historyRecord?.outputDir;
    if (!outputDir) {
      return false;
    }

    const outputRoot = path.resolve(this.settings.outputDir);
    const resolvedOutputDir = path.resolve(outputDir);
    const relative = path.relative(outputRoot, resolvedOutputDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return false;
    }

    await fs.rm(resolvedOutputDir, { recursive: true, force: true });

    if (task) {
      task.outputDir = undefined;
      task.outputFiles = {};
      this.appendTaskLog(task.id, 'warning', 'Task output directory was deleted by the user.', 'storage');
    }

    if (historyRecord) {
      historyRecord.outputDir = undefined;
      saveHistoryRecords(this.history);
    }

    this.broadcastState();
    return true;
  }

  async openSourceLocation(taskId: string): Promise<boolean> {
    const task = this.getTask(taskId);
    if (!task) {
      return false;
    }

    const revealTarget = this.getSourceLocation(task);
    if (!revealTarget) {
      return false;
    }

    return revealLocalPath(revealTarget);
  }

  getTaskFilePath(taskId: string, kind: ExportFileKind): string | undefined {
    const task = this.getTask(taskId);
    return task?.outputFiles[kind];
  }

  async revealPath(targetPath: string): Promise<boolean> {
    if (!targetPath) {
      return false;
    }

    return revealLocalPath(targetPath);
  }

  private createTaskRecord(
    input: string,
    sourceType: 'link' | 'file',
    options?: CreateTaskOptions
  ): TaskRecord {
    const now = new Date().toISOString();
    const isLinkSource = sourceType === 'link';
    const downloadBehavior = isLinkSource ? options?.downloadBehavior ?? DEFAULT_DOWNLOAD_BEHAVIOR : DEFAULT_DOWNLOAD_BEHAVIOR;
    const videoQuality = isLinkSource ? options?.videoQuality ?? DEFAULT_VIDEO_QUALITY : DEFAULT_VIDEO_QUALITY;

    let translateToChinese = options?.translateToChinese ?? this.settings.translateByDefault;
    if (downloadBehavior === 'downloadOnly') {
      translateToChinese = false;
    }

    return {
      id: randomUUID(),
      sourceType,
      input,
      displayName: pickDisplayName(input, sourceType),
      status: 'queued',
      progressPercent: 0,
      progressMessage: '等待处理',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      translateToChinese,
      downloadBehavior,
      videoQuality,
      transcriptionLanguage: options?.transcriptionLanguage ?? 'auto',
      outputFiles: {},
      logs: []
    };
  }

  private broadcastState(): void {
    if (this.stateBroadcastTimer) {
      return;
    }

    this.stateBroadcastTimer = setTimeout(() => {
      this.stateBroadcastTimer = undefined;
      const snapshot = this.getSnapshot();
      for (const listener of this.stateListeners) {
        try { listener(snapshot); }
        catch { this.stateListeners.delete(listener); }
      }
    }, 100);
  }

  private flushStateBroadcast(): void {
    if (this.stateBroadcastTimer) {
      clearTimeout(this.stateBroadcastTimer);
      this.stateBroadcastTimer = undefined;
    }

    const snapshot = this.getSnapshot();
    for (const listener of this.stateListeners) {
      try { listener(snapshot); }
      catch { this.stateListeners.delete(listener); }
    }
  }

  private mapWorkerProgress(
    task: TaskRecord,
    status: TaskRecord['status'],
    percent?: number
  ): number | undefined {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) {
      return task.progressPercent;
    }

    const raw = Math.max(0, Math.min(100, percent));
    const current = task.progressPercent ?? 0;
    let mapped = raw;

    if (task.downloadBehavior === 'downloadOnly') {
      if (status === 'downloading') {
        mapped = raw * 0.9;
      } else if (status === 'preprocessing') {
        mapped = raw === 0 && current < 1 ? current : 90 + raw * 0.09;
      } else if (status === 'completed') {
        mapped = 100;
      }
    } else {
      const transcriptionStart = task.sourceType === 'link' ? 35 : 10;
      if (status === 'downloading') {
        mapped = raw * 0.28;
      } else if (status === 'preprocessing') {
        const isInitialLinkPreparation = task.sourceType === 'link' && raw === 0 && current < 1;
        mapped = isInitialLinkPreparation ? current : (task.sourceType === 'link' ? 28 + raw * 0.07 : raw * 0.1);
      } else if (status === 'transcribing') {
        mapped = transcriptionStart + raw * ((89 - transcriptionStart) / 100);
      } else if (status === 'completed') {
        mapped = task.translateToChinese ? 89 : 100;
      }
    }

    return Math.round(Math.max(current, mapped) * 10) / 10;
  }

  private broadcastToast(title: string, message: string, tone: 'success' | 'warning' | 'error'): void {
    const toast: ToastEvent = {
      id: randomUUID(),
      title,
      message,
      tone
    };
    for (const listener of this.toastListeners) {
      listener(toast);
    }
  }

  private appendTaskLog(
    taskId: string,
    level: TaskLogEntry['level'],
    message: string,
    context?: string
  ): void {
    const task = this.getTask(taskId);
    if (!task) {
      return;
    }

    if (task.logs.length >= 300) {
      task.logs.shift();
    }
    task.logs.push({
      timestamp: new Date().toISOString(),
      level,
      message,
      context
    });

    void writeAppLog(level, message, task.displayName).catch((error) => {
      console.error('Failed to write application log:', error);
    });
    this.broadcastState();
  }

  private updateTask(
    taskId: string,
    patch: Partial<TaskRecord>,
    logMessage?: { level: TaskLogEntry['level']; message: string; context?: string }
  ): void {
    const task = this.getTask(taskId);
    if (!task) {
      return;
    }

    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    if (logMessage) {
      this.appendTaskLog(taskId, logMessage.level, logMessage.message, logMessage.context);
      return;
    }
    this.broadcastState();
  }

  private finalizeHistory(task: TaskRecord): void {
    if (!['completed', 'failed', 'partial', 'cancelled'].includes(task.status)) {
      return;
    }

    const finishedStatus = task.status as HistoryRecord['status'];
    this.history = [
      {
        id: task.id,
        displayName: task.displayName,
        sourceType: task.sourceType,
        createdAt: task.createdAt,
        finishedAt: task.updatedAt,
        status: finishedStatus,
        downloadBehavior: task.downloadBehavior,
        videoQuality: task.videoQuality,
        translateToChinese: task.translateToChinese,
        transcriptionLanguage: task.transcriptionLanguage,
        durationSeconds: task.mediaInfo?.durationSeconds,
        language: task.language,
        outputDir: task.outputDir,
        error: task.error
      },
      ...this.history.filter((item) => item.id !== task.id)
    ].slice(0, 50);

    saveHistoryRecords(this.history);
    this.broadcastState();
  }

  private async processQueue(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.queueDrain) {
      this.wakeQueueDrain?.();
      return this.queueDrain;
    }
    this.isProcessing = true;
    this.queueDrain = this.drainQueue().finally(() => {
      this.queueDrain = undefined;
      this.isProcessing = false;
      this.flushStateBroadcast();
      if (!this.shuttingDown && this.getNextQueuedTask()) void this.processQueue();
    });
    return this.queueDrain;
  }

  private async drainQueue(): Promise<void> {
    while (!this.shuttingDown) {
      let wake!: () => void;
      const queueChanged = new Promise<void>((resolve) => { wake = resolve; });
      // Subscribe before dispatching so additions and limit changes can wake
      // this drain without waiting for a running task to finish.
      this.wakeQueueDrain = wake;
      try {
        const capacity = (this.settings.maxConcurrentDownloads ?? 3)
          + (this.settings.maxConcurrentTranscriptions ?? 1)
          + (this.settings.maxConcurrentTranslations ?? 2);
        let nextTask = this.getNextQueuedTask();
        while (nextTask && this.runningTasks.size < capacity) {
          const task = nextTask;
          const pending = this.executeTask(task).finally(() => this.runningTasks.delete(task.id));
          this.runningTasks.set(task.id, pending);
          nextTask = this.getNextQueuedTask();
        }
        if (!this.runningTasks.size) return;
        await Promise.race([...this.runningTasks.values(), queueChanged]);
      } finally {
        this.wakeQueueDrain = undefined;
      }
    }
  }

  private buildOutputDir(task: TaskRecord): string {
    return path.join(this.settings.outputDir, `__working__-${task.id.slice(0, 8)}-a${task.attempts}`);
  }

  private async reserveOutputDirForDisplayName(displayName: string, currentOutputDir?: string): Promise<string> {
    const baseName = sanitizeForPath(displayName) || 'task';
    const outputRoot = currentOutputDir ? path.dirname(currentOutputDir) : this.settings.outputDir;
    let candidate = path.join(outputRoot, baseName);
    let suffix = 2;

    while (true) {
      if (currentOutputDir && path.normalize(candidate) === path.normalize(currentOutputDir)) {
        return currentOutputDir;
      }

      try {
        await fs.access(candidate);
        candidate = path.join(outputRoot, `${baseName} (${suffix})`);
        suffix += 1;
      } catch {
        return candidate;
      }
    }
  }

  private remapOutputFiles(
    sourcePathPrefix: string,
    targetPathPrefix: string,
    outputFiles: TaskRecord['outputFiles']
  ): TaskRecord['outputFiles'] {
    const rewrite = (value?: string): string | undefined => {
      if (!value || !value.startsWith(sourcePathPrefix)) {
        return value;
      }

      return path.join(targetPathPrefix, path.relative(sourcePathPrefix, value));
    };

    return {
      transcriptTxt: rewrite(outputFiles.transcriptTxt),
      transcriptSrt: rewrite(outputFiles.transcriptSrt),
      transcriptVtt: rewrite(outputFiles.transcriptVtt),
      transcriptJson: rewrite(outputFiles.transcriptJson),
      translationTxt: rewrite(outputFiles.translationTxt),
      translationSrt: rewrite(outputFiles.translationSrt),
      translationVtt: rewrite(outputFiles.translationVtt),
      translationJson: rewrite(outputFiles.translationJson),
      audio: rewrite(outputFiles.audio),
      downloadedMedia: rewrite(outputFiles.downloadedMedia),
      sourceMedia: rewrite(outputFiles.sourceMedia),
      logFile: rewrite(outputFiles.logFile),
      metadataJson: rewrite(outputFiles.metadataJson)
    };
  }

  private async finalizeOutputLocation(
    displayName: string,
    currentOutputDir: string,
    outputFiles: TaskRecord['outputFiles']
  ): Promise<{ outputDir: string; outputFiles: TaskRecord['outputFiles'] }> {
    const release = await this.outputFinalizationSlot.acquire();
    try {
      while (true) {
        const finalOutputDir = await this.reserveOutputDirForDisplayName(displayName, currentOutputDir);
        if (path.normalize(currentOutputDir) !== path.normalize(finalOutputDir)) {
          try {
            await fs.rename(currentOutputDir, finalOutputDir);
          } catch (error) {
            // Another preparing worker may have reserved the same title meanwhile.
            const occupied = await fs.stat(finalOutputDir).catch(() => undefined);
            if (occupied) continue;
            throw error;
          }
        }
        return {
          outputDir: finalOutputDir,
          outputFiles: this.remapOutputFiles(currentOutputDir, finalOutputDir, outputFiles)
        };
      }
    } finally {
      release();
    }
  }

  private getCompletionMessage(task: TaskRecord): string {
    if (task.downloadBehavior === 'downloadOnly') {
      return task.videoQuality === 'audio' ? '音频已下载完成' : '视频已下载完成';
    }

    if (task.downloadBehavior === 'downloadThenTranscribe') {
      return '视频下载和转写已完成';
    }

    return '转写已完成';
  }

  private getSuccessToast(task: TaskRecord): { title: string; message: string } {
    if (task.downloadBehavior === 'downloadOnly') {
      return {
        title: '下载完成',
        message: `${task.displayName} 已保存到输出目录。`
      };
    }

    if (task.downloadBehavior === 'downloadThenTranscribe') {
      return {
        title: '任务完成',
        message: `${task.displayName} 的下载和转写已完成。`
      };
    }

    return {
      title: '转写完成',
      message: `${task.displayName} 已完成转写。`
    };
  }

  private markTaskCompleted(task: TaskRecord, progressMessage: string, patch?: Partial<TaskRecord>): void {
    this.throwIfTaskCancelled(task);
    this.updateTask(task.id, {
      status: 'completed',
      progressPercent: 100,
      progressMessage,
      ...patch
    });
  }

  private throwIfTaskCancelled(task: TaskRecord): void {
    if (this.cancellingTaskIds.has(task.id)) {
      throw new CancelledTaskError();
    }
  }

  private async executeTask(task: TaskRecord): Promise<void> {
    const runtimeSettings = { ...this.settings };
    if (task.sourceType === 'link') {
      const normalizedInput = normalizeLinkCandidate(task.input) ?? task.input;
      if (normalizedInput !== task.input) {
        task.input = normalizedInput;
        task.displayName = pickDisplayName(normalizedInput, 'link');
      }
    }

    task.attempts += 1;
    task.outputDir = this.buildOutputDir(task);
    this.taskControllers.set(task.id, new AbortController());
    this.updateTask(task.id, {
      status: task.sourceType === 'link' ? 'downloading' : 'preprocessing',
      progressPercent: 0,
      progressMessage: task.sourceType === 'link' ? '正在准备下载资源' : '正在准备处理本地文件',
      error: undefined,
      errorCode: undefined,
      warning: undefined
    });

    const request: WorkerTaskRequest = {
      taskId: task.id,
      sourceType: task.sourceType,
      input: task.input,
      displayName: task.displayName,
      outputDir: task.outputDir,
      whisperModel: runtimeSettings.whisperModel,
      transcriptionEngine: runtimeSettings.transcriptionEngine,
      youtubeCookieSource: runtimeSettings.youtubeCookieSource ?? 'auto',
      youtubeBrowserProfile: runtimeSettings.youtubeBrowserProfile,
      downloadConnections: runtimeSettings.downloadConnections ?? 8,
      keepAudio: runtimeSettings.keepAudio,
      logLevel: runtimeSettings.logLevel,
      downloadBehavior: task.downloadBehavior,
      videoQuality: task.videoQuality,
      transcriptionLanguage:
        task.transcriptionLanguage === 'auto' ? undefined : task.transcriptionLanguage,
      projectRoot: getProjectRoot()
    };

    try {
      await fs.mkdir(task.outputDir, { recursive: true });
      this.throwIfTaskCancelled(task);
      const workerResult = await this.runWorkerTask(task, request, runtimeSettings);
      this.throwIfTaskCancelled(task);

      const resolvedDisplayName =
        workerResult.displayName && !looksGarbledText(workerResult.displayName)
          ? workerResult.displayName
          : task.displayName;
      const finalizedOutput = await this.finalizeOutputLocation(
        resolvedDisplayName,
        workerResult.outputDir,
        workerResult.outputFiles
      );

      this.throwIfTaskCancelled(task);
      this.updateTask(task.id, {
        displayName: resolvedDisplayName,
        transcriptText: workerResult.transcriptText,
        transcriptSegments: workerResult.transcriptSegments,
        language: workerResult.language,
        mediaInfo: workerResult.mediaInfo,
        outputFiles: finalizedOutput.outputFiles,
        outputDir: finalizedOutput.outputDir
      });

      if (task.downloadBehavior !== 'downloadOnly' && task.translateToChinese) {
        this.updateTask(task.id, { status: 'translating', progressMessage: '正在等待翻译资源' });
        const releaseTranslation = await this.translationSlots.acquire(this.taskControllers.get(task.id)?.signal);
        try {
          this.throwIfTaskCancelled(task);
          await this.runTranslation(task);
        } finally {
          releaseTranslation();
        }
      } else {
        this.markTaskCompleted(task, this.getCompletionMessage(task));
      }

      if (task.status === 'completed') {
        const toast = this.getSuccessToast(task);
        this.broadcastToast(toast.title, toast.message, 'success');
      } else if (task.status === 'partial') {
        this.broadcastToast(
          '转写完成，翻译未完成',
          task.warning ?? '原文结果已经保留在输出目录中。',
          'warning'
        );
      }
    } catch (error) {
      if (error instanceof CancelledTaskError || this.cancellingTaskIds.has(task.id)) {
        this.updateTask(task.id, {
          status: 'cancelled',
          progressMessage: '任务已取消',
          error: undefined,
          errorCode: 'cancelled'
        });
      } else {
        let message =
          error instanceof Error ? error.message : '任务执行失败了，请打开日志查看详情。';
        const code =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'task_failed';

        if (isDouyinLink(task.input) && code === 'auth_required') {
          message = '抖音解析失败：当前下载链路未拿到可用媒体地址，可能需要更新 yt-dlp 或提供有效 Cookie。';
        }

        this.updateTask(
          task.id,
          {
            status: 'failed',
            progressMessage: '任务失败',
            error: message,
            errorCode: code
          },
          {
            level: 'error',
            message
          }
        );

        this.broadcastToast('任务失败', message, 'error');
      }
    } finally {
      this.finalizeHistory(task);
      this.cancellingTaskIds.delete(task.id);
      this.taskControllers.delete(task.id);
      this.flushStateBroadcast();
    }
  }

  private createWorker(settings: SettingsData = this.settings): PythonWorkerClient {
    const env = buildPythonEnv();
    const libraries = this.modelPreparation.getPythonLibraryDirs(settings.pythonPath);
    if (process.platform === 'linux' && libraries.length) env.LD_LIBRARY_PATH = [...new Set([...libraries, ...(env.LD_LIBRARY_PATH || '').split(':').filter(Boolean)])].join(':');
    return new PythonWorkerClient({
      pythonPath: settings.pythonPath,
      workerScriptPath: getWorkerScriptPath(),
      env
    });
  }

  private async retireIdleWorkers(): Promise<void> {
    const retired: PythonWorkerClient[] = [];
    for (let index = this.transcriptionWorkers.length - 1; index >= 0; index--) {
      const worker = this.transcriptionWorkers[index];
      if (!worker.busy && (worker.pythonPath !== this.settings.pythonPath || worker.engine !== this.settings.transcriptionEngine ||
          this.transcriptionWorkers.length > (this.settings.maxConcurrentTranscriptions ?? 1))) {
        this.transcriptionWorkers.splice(index, 1);
        retired.push(worker.client);
      }
    }
    await Promise.allSettled(retired.map((worker) => worker.shutdown()));
  }

  private handleWorkerEvent(task: TaskRecord, event: WorkerEvent): void {
    if (this.cancellingTaskIds.has(task.id)) return;
    if (event.type === 'log') {
      this.appendTaskLog(task.id, event.level, event.message, event.context);
    } else if (event.type === 'metadata') {
      this.updateTask(task.id, {
        displayName: event.displayName ?? task.displayName,
        outputDir: event.outputDir ?? task.outputDir
      });
    } else if (event.type === 'progress') {
      // Completion is committed after artifacts have been finalized by this task.
      const status = event.status === 'completed' ? 'preprocessing' : event.status;
      const continuingToTranslation = event.status === 'completed'
        && task.translateToChinese && task.downloadBehavior !== 'downloadOnly';
      this.updateTask(task.id, {
        status: continuingToTranslation ? 'transcribing' : status,
        progressPercent: continuingToTranslation ? 89 : this.mapWorkerProgress(task, event.status, event.percent),
        progressMessage: continuingToTranslation ? '转写已完成，正在准备翻译' : event.message
      });
    }
  }

  private async runWorkerTask(task: TaskRecord, request: WorkerTaskRequest, runtimeSettings: SettingsData = this.settings): Promise<WorkerResultPayload> {
    const signal = this.taskControllers.get(task.id)?.signal;
    const modelSettings = { pythonPath: runtimeSettings.pythonPath, transcriptionEngine: request.transcriptionEngine, whisperModel: request.whisperModel };
    if (request.downloadBehavior !== 'downloadOnly') this.modelPreparation.prepare(modelSettings, true);
    this.updateTask(task.id, {
      status: 'preprocessing', progressMessage: task.sourceType === 'link' ? '正在等待下载资源' : '正在等待媒体准备资源'
    });
    const releaseDownload = await this.downloadSlots.acquire(signal);
    let prepared: WorkerResultPayload;
    const prepareWorker = this.createWorker(runtimeSettings);
    this.preparationWorkers.add(prepareWorker);
    try {
      this.throwIfTaskCancelled(task);
      this.updateTask(task.id, { status: task.sourceType === 'link' ? 'downloading' : 'preprocessing',
        progressMessage: task.sourceType === 'link' ? '正在准备下载资源' : '正在准备处理本地文件' });
      prepared = await prepareWorker.run({ ...request, phase: 'prepare' }, (event) => this.handleWorkerEvent(task, event), signal);
    } finally {
      await prepareWorker.shutdown();
      this.preparationWorkers.delete(prepareWorker);
      releaseDownload();
    }
    this.throwIfTaskCancelled(task);
    if (request.downloadBehavior === 'downloadOnly') return prepared;
    if (!prepared.preparedMedia) throw new Error('媒体准备结果不完整，无法开始转写。');
    this.updateTask(task.id, { status: 'preprocessing', progressMessage: `正在等待 ${request.whisperModel} 模型就绪` });
    const preparedModelPath = await this.modelPreparation.waitFor(modelSettings, signal);
    this.throwIfTaskCancelled(task);
    this.updateTask(task.id, { status: 'preprocessing', progressMessage: '媒体已准备，正在等待显卡转写资源' });
    const releaseTranscription = await this.transcriptionSlots.acquire(signal);
    let worker = this.transcriptionWorkers.find((item) => !item.busy && item.pythonPath === runtimeSettings.pythonPath && item.engine === request.transcriptionEngine);
    if (!worker) {
      worker = { client: this.createWorker(runtimeSettings), busy: false, pythonPath: runtimeSettings.pythonPath, engine: request.transcriptionEngine };
      this.transcriptionWorkers.push(worker);
    }
    worker.busy = true;
    try {
      this.throwIfTaskCancelled(task);
      return await worker.client.run({ ...request, phase: 'transcribe', preparedModelPath, displayName: prepared.displayName,
        outputDir: prepared.outputDir, preparedMedia: prepared.preparedMedia },
        (event) => this.handleWorkerEvent(task, event), signal);
    } finally {
      worker.busy = false;
      releaseTranscription();
      await this.retireIdleWorkers();
    }
  }

  private async runTranslation(task: TaskRecord): Promise<void> {
    const service = this.settings.translationServices.find(
      (candidate) => candidate.id === this.settings.activeTranslationServiceId && candidate.enabled
    );
    const transcriptText = task.transcriptText ?? '';
    const transcriptSegments = task.transcriptSegments ?? [];
    const outputDir = task.outputDir ?? this.settings.outputDir;

    if (!service) {
      this.updateTask(task.id, {
        status: 'partial',
        progressPercent: 100,
        progressMessage: '已完成转写，未配置翻译服务',
        warning: '请先在设置页添加并启用一个自定义翻译服务。'
      });
      return;
    }

    const mapTranslationProgress = (current: number, total: number): number => {
      if (total <= 0) {
        return 90;
      }

      const normalized = Math.max(0, Math.min(1, current / total));
      return Math.max(90, Math.min(99, 90 + Math.round(normalized * 9)));
    };
    const onLog = (message: string): void => {
      this.appendTaskLog(task.id, 'info', message, 'translation');
    };
    const isCancelled = (): boolean => this.cancellingTaskIds.has(task.id);

    this.updateTask(task.id, {
      status: 'translating',
      progressPercent: 90,
      progressMessage: `正在使用 ${service.name} 翻译为中文`
    });

    try {
      const apiKey = getTranslationServiceApiKey(service.id);
      const translation = await translateSegmentsToChinese(transcriptText, transcriptSegments, {
        apiKey: apiKey.value,
        model: service.model,
        baseUrl: service.apiUrl,
        customContent: service.customContent,
        enableAiContext: service.enableAiContext,
        systemPrompt: service.systemPrompt,
        multiplePrompt: service.multiplePrompt,
        prompt: service.prompt,
        requestLimit: service.requestLimit,
        maxTextLengthPerRequest: service.maxTextLengthPerRequest,
        maxTextGroupLengthPerRequest: service.maxTextGroupLengthPerRequest,
        enableRichTranslate: service.enableRichTranslate,
        maxTextGroupLengthPerRequestForSubtitle: service.maxTextGroupLengthPerRequestForSubtitle,
        subtitlePrompt: service.subtitlePrompt,
        temperature: service.temperature,
        outputDir,
        outputBaseName: task.displayName,
        onLog,
        isCancelled,
        signal: this.taskControllers.get(task.id)?.signal,
        onProgress: (current, total) => {
          this.updateTask(task.id, {
            status: 'translating',
            progressPercent: mapTranslationProgress(current, total),
            progressMessage:
              current >= total ? '正在整理翻译结果' : `正在翻译第 ${current + 1} / ${total} 段`
          });
        }
      });

      this.markTaskCompleted(
        task,
        task.downloadBehavior === 'downloadThenTranscribe' ? '视频下载、转写和翻译已完成' : '转写和翻译已完成',
        {
          translationText: translation.text,
          translationSegments: translation.segments,
          outputFiles: {
            ...task.outputFiles,
            ...translation.outputFiles
          }
        }
      );
    } catch (error) {
      if (this.cancellingTaskIds.has(task.id) ||
        (error instanceof TranslationError && error.code === 'cancelled')) {
        throw new CancelledTaskError();
      }

      const message = error instanceof Error ? error.message : '翻译请求失败了。';
      this.updateTask(
        task.id,
        {
          status: 'partial',
          progressPercent: 100,
          progressMessage: '转写已完成，翻译失败',
          warning: message
        },
        {
          level: 'warning',
          message,
          context: 'translation'
        }
      );
    }
  }

  private async refreshEnvironmentInBackground(): Promise<void> {
    const settings = this.settings;
    const revision = ++this.environmentRevision;
    try {
      const environment = await runEnvironmentCheck(settings);
      if (revision !== this.environmentRevision || this.settings !== settings || this.shuttingDown) return;
      this.environment = environment;
      this.broadcastState();
    } catch (error) {
      await writeAppLog(
        'warning',
        `Background environment refresh failed: ${error instanceof Error ? error.message : String(error)}`
      ).catch((logError) => console.error('Failed to write application log:', logError));
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.wakeQueueDrain?.();
    for (const [taskId, controller] of this.taskControllers) {
      this.cancellingTaskIds.add(taskId);
      controller.abort();
    }
    await this.modelPreparation.shutdown();
    await Promise.allSettled([...this.runningTasks.values()]);
    await Promise.allSettled([
      ...[...this.preparationWorkers].map((worker) => worker.shutdown()),
      ...this.transcriptionWorkers.map((worker) => worker.client.shutdown())
    ]);
    this.transcriptionWorkers.length = 0;
  }
}
