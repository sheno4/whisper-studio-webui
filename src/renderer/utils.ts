import type {
  DownloadBehavior,
  HistoryRecord,
  TaskRecord,
  TaskStatus,
  VideoQualityOption
} from '../shared/types';
import { TRANSCRIPTION_LANGUAGE_OPTIONS } from '../shared/constants';

export const statusLabels: Record<TaskStatus, string> = {
  queued: '等待中',
  downloading: '下载中',
  preprocessing: '处理中',
  transcribing: '转写中',
  translating: '翻译中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  partial: '部分完成'
};

export const statusTones: Record<TaskStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  downloading: 'info',
  preprocessing: 'info',
  transcribing: 'info',
  translating: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warning',
  partial: 'warning'
};

export const downloadBehaviorLabels: Record<DownloadBehavior, string> = {
  transcribe: '仅转写',
  downloadThenTranscribe: '下载后转写',
  downloadOnly: '仅下载媒体'
};

export const videoQualityLabels: Record<VideoQualityOption, string> = {
  best: '自动 / 最佳',
  '1080p': '1080p',
  '720p': '720p',
  '480p': '480p',
  audio: '仅音频'
};

const systemTextReplacements: Array<[string, string]> = [
  ['OpenAI API key', 'OpenAI API Key']
];

export const normalizeUiText = (value?: string): string => {
  if (!value) {
    return '';
  }

  let normalized = value;
  for (const [from, to] of systemTextReplacements) {
    normalized = normalized.split(from).join(to);
  }

  return normalized.replace(/[锟�]/g, '').trim();
};

export const formatProgressPercent = (value?: number): string | undefined => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }

  const clamped = Math.max(0, Math.min(100, value));
  const rounded = Math.round(clamped * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
};

export const formatDateTime = (value?: string): string => {
  if (!value) {
    return '--';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
};

export const formatLongDateTime = (value?: string): string => {
  if (!value) {
    return '--';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
};

export const formatDuration = (value?: number): string => {
  if (!value || Number.isNaN(value)) {
    return '--';
  }

  const totalSeconds = Math.max(0, Math.round(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分钟`;
  }

  if (minutes > 0) {
    return `${minutes} 分 ${seconds} 秒`;
  }

  return `${seconds} 秒`;
};

export const isTaskActive = (task: TaskRecord): boolean => {
  return ['queued', 'downloading', 'preprocessing', 'transcribing', 'translating'].includes(task.status);
};

export const isTaskFinished = (task: TaskRecord | HistoryRecord): boolean => {
  return ['completed', 'failed', 'partial', 'cancelled'].includes(task.status);
};

export const truncate = (value: string, length = 68): string => {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, length - 1)}…`;
};

export const looksGarbledText = (value?: string): boolean => {
  if (!value) {
    return false;
  }

  return /(?:锟|濮|鏉|缂|闁|閺|閸|鍤|绉|鐦)/.test(value);
};

const basenameOfPath = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }

  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1);
};

interface ReadableNameSource {
  displayName: string;
  sourceType: HistoryRecord['sourceType'];
  outputDir?: string;
  input?: string;
}

export const getReadableName = (value: ReadableNameSource): string => {
  if (!looksGarbledText(value.displayName)) {
    return value.displayName;
  }

  if (value.sourceType === 'file') {
    return basenameOfPath(value.input || value.displayName) || '本地文件任务';
  }

  if (value.input) {
    try {
      const url = new URL(value.input);
      return `${url.hostname}${url.pathname}`.slice(0, 80);
    } catch {
      return value.input.slice(0, 80);
    }
  }

  return basenameOfPath(value.outputDir) || '链接任务';
};

export const toCssFileUrl = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }

  if (/^(?:https?:)?\/\//i.test(value) || value.startsWith('/')) {
    return encodeURI(value);
  }

  return undefined;
};

export const describeTaskMode = (task: Pick<TaskRecord, 'downloadBehavior' | 'videoQuality'>): string => {
  if (task.downloadBehavior === 'transcribe') {
    return downloadBehaviorLabels.transcribe;
  }

  return `${downloadBehaviorLabels[task.downloadBehavior]} · ${videoQualityLabels[task.videoQuality]}`;
};

export const getTranscriptionLanguageLabel = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }

  return TRANSCRIPTION_LANGUAGE_OPTIONS.find((option) => option.value === value)?.label ?? value;
};

export const describeTaskLanguage = (task: {
  transcriptionLanguage?: string;
  language?: string;
}): string | undefined => {
  if (task.transcriptionLanguage && task.transcriptionLanguage !== 'auto') {
    return `指定 ${getTranscriptionLanguageLabel(task.transcriptionLanguage)}`;
  }

  const detected = getTranscriptionLanguageLabel(task.language);
  return detected ? `识别 ${detected}` : undefined;
};

// IDs identify UI records; they are not authentication tokens. LAN HTTP pages
// cannot call randomUUID, although getRandomValues is usually still available.
export const createRandomId = (): string => {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    try {
      return webCrypto.randomUUID();
    } catch {
      // Fall through when an embedded browser exposes an unusable implementation.
    }
  }

  const bytes = new Uint8Array(16);
  try {
    if (typeof webCrypto?.getRandomValues !== 'function') {
      throw new Error('Web Crypto is unavailable.');
    }
    webCrypto.getRandomValues(bytes);
  } catch {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const copyTextToClipboard = async (text: string): Promise<void> => {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission errors and insecure contexts can still allow a user-initiated
      // copy through the older DOM API.
    }
  }
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
    throw new Error('当前浏览器不支持自动复制，请手动选中文本复制。');
  }

  const previousFocus = document.activeElement;
  const inputSelection = previousFocus instanceof HTMLInputElement || previousFocus instanceof HTMLTextAreaElement
    ? { start: previousFocus.selectionStart, end: previousFocus.selectionEnd, direction: previousFocus.selectionDirection }
    : undefined;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) {
      throw new Error('浏览器拒绝了复制操作，请手动选中文本复制。');
    }
  } finally {
    textarea.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus({ preventScroll: true });
      if (inputSelection && inputSelection.start !== null && inputSelection.end !== null) {
        (previousFocus as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(
          inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined
        );
      }
    }
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) {
        selection.addRange(range);
      }
    }
  }
};
