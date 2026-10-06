import { useCallback, useMemo, useRef, useState } from 'react';

import { extractLinksFromText } from '../../shared/link-parser';
import type {
  AppSnapshot,
  DownloadBehavior,
  ExportFileKind,
  HistoryRecord,
  SaveSettingsPayload,
  TaskRecord,
  ToastEvent,
  TranscriptionLanguage,
  VideoQualityOption
} from '../../shared/types';
import { copyTextToClipboard, formatDateTime, getReadableName, isTaskActive, normalizeUiText, toCssFileUrl } from '../utils';
import { useDesktopSnapshot } from './useDesktopSnapshot';
import { useToastQueue } from './useToastQueue';
import { useWorkspaceSelection } from './useWorkspaceSelection';
import type { ActivityView } from './useWorkspaceSelection';

export type { ActivityView } from './useWorkspaceSelection';

export interface ConfirmationRequest {
  title: string;
  message: string;
  confirmLabel: string;
  tone: 'default' | 'danger';
  action: () => Promise<void>;
}

interface FooterContent {
  context: string;
  title: string;
  message: string;
  timestamp: string;
}

interface ComposerState {
  linkInput: string;
  translateNext: boolean;
  downloadBehavior: DownloadBehavior;
  videoQuality: VideoQualityOption;
  transcriptionLanguage: TranscriptionLanguage;
  busy: boolean;
}

interface ActivityState {
  view: ActivityView;
  selectedTaskId?: string;
  selectedHistoryId?: string;
  selectedTask?: TaskRecord;
  selectedHistoryRecord?: HistoryRecord;
  activeTask?: TaskRecord;
  activeHistoryRecord?: HistoryRecord;
}

export interface WhisperWorkspaceController {
  snapshot: AppSnapshot | null;
  loadError?: string;
  wallpaperUrl?: string;
  activeTaskCount: number;
  composer: ComposerState;
  activity: ActivityState;
  footer: FooterContent;
  settingsOpen: boolean;
  savingServiceId: string | null;
  isDragging: boolean;
  toasts: ToastEvent[];
  confirmation: ConfirmationRequest | null;
  confirming: boolean;
  setLinkInput: (value: string) => void;
  setTranslateNext: (value: boolean) => void;
  setDownloadBehavior: (value: DownloadBehavior) => void;
  setVideoQuality: (value: VideoQualityOption) => void;
  setTranscriptionLanguage: (value: TranscriptionLanguage) => void;
  setActivityView: (value: ActivityView) => void;
  setSelectedTaskId: (value: string) => void;
  setSelectedHistoryId: (value: string) => void;
  setSettingsOpen: (value: boolean) => void;
  setIsDragging: (value: boolean) => void;
  addLinks: () => Promise<void>;
  pickFiles: () => Promise<void>;
  addDroppedFiles: (files: File[]) => Promise<void>;
  copyText: (text: string, label: string) => Promise<void>;
  requestDeleteTaskDirectory: (taskId: string) => void;
  requestClearHistory: () => void;
  dismissConfirmation: () => void;
  confirmAction: () => Promise<void>;
  saveSettings: (payload: SaveSettingsPayload) => Promise<void>;
  changeTranslationService: (serviceId: string) => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  removeTask: (taskId: string) => Promise<void>;
  removeHistory: (historyId: string) => Promise<void>;
  revealPath: (targetPath: string) => Promise<void>;
  openOutputDirectory: (taskId: string) => Promise<void>;
  openSourceLocation: (taskId: string) => Promise<void>;
  exportTaskFile: (taskId: string, kind: ExportFileKind) => Promise<void>;
  reload: () => Promise<void>;
}

const DEFAULT_DOWNLOAD_BEHAVIOR: DownloadBehavior = 'transcribe';
const DEFAULT_VIDEO_QUALITY: VideoQualityOption = 'best';
const DEFAULT_TRANSCRIPTION_LANGUAGE: TranscriptionLanguage = 'auto';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createFooterContent(
  view: ActivityView,
  selectedTask?: TaskRecord,
  selectedHistory?: HistoryRecord
): FooterContent {
  if (view === 'history' && selectedHistory) {
    return {
      context: '历史',
      title: getReadableName(selectedHistory),
      message: selectedHistory.error ? normalizeUiText(selectedHistory.error) : '历史任务摘要与输出位置',
      timestamp: formatDateTime(selectedHistory.finishedAt)
    };
  }

  if (selectedTask) {
    return {
      context: '队列',
      title: getReadableName(selectedTask),
      message: normalizeUiText(selectedTask.progressMessage) || '等待任务启动',
      timestamp: formatDateTime(selectedTask.updatedAt)
    };
  }

  return {
    context: view === 'queue' ? '队列' : '历史',
    title: '未选择任务',
    message: '导入媒体后，任务状态与结果会显示在这里。',
    timestamp: '就绪'
  };
}

export function useWhisperWorkspace(): WhisperWorkspaceController {
  const [linkInput, setLinkInput] = useState('');
  const [translateNext, setTranslateNext] = useState(false);
  const [downloadBehavior, setDownloadBehavior] = useState<DownloadBehavior>(DEFAULT_DOWNLOAD_BEHAVIOR);
  const [videoQuality, setVideoQuality] = useState<VideoQualityOption>(DEFAULT_VIDEO_QUALITY);
  const [transcriptionLanguage, setTranscriptionLanguage] = useState<TranscriptionLanguage>(
    DEFAULT_TRANSCRIPTION_LANGUAGE
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const creatingTaskRef = useRef(false);
  const [savingServiceId, setSavingServiceId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [confirming, setConfirming] = useState(false);
  const didHydrateTranslateDefault = useRef(false);
  const { toasts, pushToast } = useToastQueue();

  const hydrateTranslateDefault = useCallback((nextSnapshot: AppSnapshot): void => {
    if (didHydrateTranslateDefault.current) {
      return;
    }

    setTranslateNext(nextSnapshot.settings.translateByDefault);
    didHydrateTranslateDefault.current = true;
  }, []);

  const { snapshot, loadError, reload, includeCreatedTasks } = useDesktopSnapshot(hydrateTranslateDefault);
  const {
    activityView,
    selectedTaskId,
    selectedHistoryId,
    selectedTask,
    selectedHistoryRecord,
    activeTask,
    activeHistoryRecord,
    setActivityView,
    setSelectedTaskId,
    setSelectedHistoryId,
    focusCreatedTasks
  } = useWorkspaceSelection(snapshot);
  const activeTaskCount = snapshot?.tasks.filter(isTaskActive).length ?? 0;
  const footer = useMemo(
    () => createFooterContent(activityView, selectedTask, selectedHistoryRecord),
    [activityView, selectedHistoryRecord, selectedTask]
  );

  const beginCreatingTask = useCallback((): boolean => {
    if (creatingTaskRef.current) {
      pushToast({ title: '正在导入任务', message: '请等待本次导入完成后再添加文件或链接。', tone: 'warning' });
      return false;
    }
    creatingTaskRef.current = true;
    setCreatingTask(true);
    return true;
  }, [pushToast]);

  const finishCreatingTask = useCallback((): void => {
    creatingTaskRef.current = false;
    setCreatingTask(false);
  }, []);

  const addLinks = useCallback(async (): Promise<void> => {
    const links = extractLinksFromText(linkInput);
    if (links.length === 0) {
      pushToast({
        title: '没有识别到链接',
        message: '请粘贴媒体链接，或直接粘贴站点分享文案。',
        tone: 'warning'
      });
      return;
    }

    if (!beginCreatingTask()) {
      return;
    }
    try {
      const created = await window.whisperWeb.addLinkTasks(links, {
        translateToChinese: downloadBehavior === 'downloadOnly' ? false : translateNext,
        downloadBehavior,
        videoQuality,
        transcriptionLanguage
      });
      setLinkInput((current) => current === linkInput ? '' : current);
      includeCreatedTasks(created);
      focusCreatedTasks(created);
    } catch (error) {
      pushToast({ title: '任务创建失败', message: getErrorMessage(error), tone: 'error' }, 4800);
    } finally {
      finishCreatingTask();
    }
  }, [
    beginCreatingTask,
    downloadBehavior,
    focusCreatedTasks,
    finishCreatingTask,
    includeCreatedTasks,
    linkInput,
    pushToast,
    transcriptionLanguage,
    translateNext,
    videoQuality
  ]);

  const createFileTasks = useCallback(
    async (filePaths: string[]): Promise<void> => {
      if (filePaths.length === 0) {
        return;
      }
      const created = await window.whisperWeb.addFileTasks(filePaths, {
        translateToChinese: translateNext,
        transcriptionLanguage
      });
      includeCreatedTasks(created);
      focusCreatedTasks(created);
    },
    [focusCreatedTasks, includeCreatedTasks, transcriptionLanguage, translateNext]
  );

  const beginFileImport = useCallback((): boolean => {
    if (downloadBehavior === 'downloadOnly') {
      pushToast({
        title: '未启用生成转写',
        message: '本地文件不需要再次下载，请先勾选“生成转写”。',
        tone: 'warning'
      });
      return false;
    }
    return beginCreatingTask();
  }, [beginCreatingTask, downloadBehavior, pushToast]);

  const pickFiles = useCallback(async (): Promise<void> => {
    if (!beginFileImport()) {
      return;
    }
    try {
      const filePaths = await window.whisperWeb.pickFiles();
      await createFileTasks(filePaths);
    } catch (error) {
      pushToast({ title: '文件导入失败', message: getErrorMessage(error), tone: 'error' }, 4800);
    } finally {
      finishCreatingTask();
    }
  }, [beginFileImport, createFileTasks, finishCreatingTask, pushToast]);

  const addDroppedFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0 || !beginFileImport()) {
        return;
      }
      try {
        const filePaths = await window.whisperWeb.uploadFiles(files);
        if (filePaths.length === 0) {
          pushToast({ title: '没有可导入的文件', message: '请拖入本机媒体文件。', tone: 'warning' });
          return;
        }
        await createFileTasks(filePaths);
      } catch (error) {
        pushToast({ title: '拖放导入失败', message: getErrorMessage(error), tone: 'error' }, 4800);
      } finally {
        finishCreatingTask();
      }
    },
    [beginFileImport, createFileTasks, finishCreatingTask, pushToast]
  );

  const copyText = useCallback(
    async (text: string, label: string): Promise<void> => {
      try {
        await copyTextToClipboard(text);
        pushToast({ title: '已复制', message: `${label}已复制到剪贴板。`, tone: 'success' });
      } catch (error) {
        pushToast({ title: '复制失败', message: getErrorMessage(error), tone: 'error' });
      }
    },
    [pushToast]
  );

  const requestDeleteTaskDirectory = useCallback(
    (taskId: string): void => {
      setConfirmation({
        title: '删除输出目录？',
        message: '转写、字幕、日志和下载媒体都会从本机删除，此操作无法撤销。',
        confirmLabel: '删除目录',
        tone: 'danger',
        action: async () => {
          const deleted = await window.whisperWeb.deleteTaskDirectory(taskId);
          if (!deleted) {
            pushToast({ title: '未能删除目录', message: '任务仍在运行，或目录已经不存在。', tone: 'warning' });
            return;
          }
          pushToast({ title: '目录已删除', message: '任务输出已从本机移除。', tone: 'success' });
        }
      });
    },
    [pushToast]
  );

  const requestClearHistory = useCallback((): void => {
    if (!snapshot || snapshot.history.length === 0) {
      return;
    }

    setConfirmation({
      title: '清空历史记录？',
      message: `将移除 ${snapshot.history.length} 条历史摘要，输出文件仍会保留在原目录。`,
      confirmLabel: '清空记录',
      tone: 'danger',
      action: async () => {
        await window.whisperWeb.clearHistory();
        pushToast({ title: '历史记录已清空', message: '输出文件没有被删除。', tone: 'success' });
      }
    });
  }, [pushToast, snapshot]);

  const dismissConfirmation = useCallback((): void => {
    if (!confirming) {
      setConfirmation(null);
    }
  }, [confirming]);

  const confirmAction = useCallback(async (): Promise<void> => {
    if (!confirmation || confirming) {
      return;
    }

    setConfirming(true);
    try {
      await confirmation.action();
      setConfirmation(null);
    } catch (error) {
      pushToast({ title: '操作失败', message: getErrorMessage(error), tone: 'error' }, 4800);
    } finally {
      setConfirming(false);
    }
  }, [confirmation, confirming, pushToast]);

  const saveSettings = useCallback(
    async (payload: SaveSettingsPayload): Promise<void> => {
      const settings = await window.whisperWeb.saveSettings(payload);
      setTranslateNext(settings.translateByDefault);
      pushToast({ title: '设置已保存', message: '新任务使用新的默认配置；缺少的模型会自动准备，无需重启。', tone: 'success' });
    },
    [pushToast]
  );

  const changeTranslationService = useCallback(
    async (serviceId: string): Promise<void> => {
      if (!snapshot || snapshot.settings.activeTranslationServiceId === serviceId || savingServiceId) {
        return;
      }

      const service = snapshot.settings.translationServices.find((candidate) => candidate.id === serviceId);
      setSavingServiceId(serviceId);
      try {
        await window.whisperWeb.setActiveTranslationService(serviceId);
        pushToast({
          title: '翻译服务已切换',
          message: `后续任务会使用 ${service?.name || '所选服务'}。`,
          tone: 'success'
        });
      } catch (error) {
        pushToast({ title: '切换失败', message: getErrorMessage(error), tone: 'error' }, 4800);
      } finally {
        setSavingServiceId(null);
      }
    },
    [pushToast, savingServiceId, snapshot]
  );

  const runCommand = useCallback(
    async (label: string, command: () => Promise<unknown>): Promise<void> => {
      try {
        const result = await command();
        if (result === false) throw new Error('操作未完成，目标可能已被移除，请刷新后重试。');
      } catch (error) {
        pushToast({ title: `${label}失败`, message: getErrorMessage(error), tone: 'error' }, 4800);
      }
    },
    [pushToast]
  );

  const retryTask = useCallback(
    (taskId: string): Promise<void> => runCommand('重试任务', () => window.whisperWeb.retryTask(taskId)),
    [runCommand]
  );

  const cancelTask = useCallback(
    (taskId: string): Promise<void> => runCommand('取消任务', () => window.whisperWeb.cancelTask(taskId)),
    [runCommand]
  );

  const removeTask = useCallback(
    (taskId: string): Promise<void> => runCommand('移除任务', () => window.whisperWeb.removeTask(taskId)),
    [runCommand]
  );

  const removeHistory = useCallback(
    (historyId: string): Promise<void> =>
      runCommand('移除历史记录', () => window.whisperWeb.removeHistoryItem(historyId)),
    [runCommand]
  );

  const revealPath = useCallback(
    (targetPath: string): Promise<void> => runCommand('定位文件', () => window.whisperWeb.revealPath(targetPath)),
    [runCommand]
  );

  const openOutputDirectory = useCallback(
    (taskId: string): Promise<void> => runCommand('打开输出目录', () => window.whisperWeb.openOutputDir(taskId)),
    [runCommand]
  );

  const openSourceLocation = useCallback(
    (taskId: string): Promise<void> => runCommand('定位源文件', () => window.whisperWeb.openSourceLocation(taskId)),
    [runCommand]
  );

  const exportTaskFile = useCallback(
    (taskId: string, kind: ExportFileKind): Promise<void> =>
      runCommand('导出文件', () => window.whisperWeb.exportTaskFile(taskId, kind)),
    [runCommand]
  );

  return {
    snapshot,
    loadError,
    wallpaperUrl: toCssFileUrl(snapshot?.settings.wallpaperPath),
    activeTaskCount,
    composer: {
      linkInput,
      translateNext,
      downloadBehavior,
      videoQuality,
      transcriptionLanguage,
      busy: creatingTask
    },
    activity: {
      view: activityView,
      selectedTaskId,
      selectedHistoryId,
      selectedTask,
      selectedHistoryRecord,
      activeTask,
      activeHistoryRecord
    },
    footer,
    settingsOpen,
    savingServiceId,
    isDragging,
    toasts,
    confirmation,
    confirming,
    setLinkInput,
    setTranslateNext,
    setDownloadBehavior,
    setVideoQuality,
    setTranscriptionLanguage,
    setActivityView,
    setSelectedTaskId,
    setSelectedHistoryId,
    setSettingsOpen,
    setIsDragging,
    addLinks,
    pickFiles,
    addDroppedFiles,
    copyText,
    requestDeleteTaskDirectory,
    requestClearHistory,
    dismissConfirmation,
    confirmAction,
    saveSettings,
    changeTranslationService,
    retryTask,
    cancelTask,
    removeTask,
    removeHistory,
    revealPath,
    openOutputDirectory,
    openSourceLocation,
    exportTaskFile,
    reload
  };
}
