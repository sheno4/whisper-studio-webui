import type { TranscriptionLanguage } from './types';

export const APP_NAME = 'Whisper Studio';
export const DEFAULT_WHISPER_MODEL = 'turbo';
export const DEFAULT_TRANSCRIPTION_ENGINE = 'faster-whisper';
export const OPENAI_WHISPER_MODEL_OPTIONS = [
  'tiny.en',
  'tiny',
  'base.en',
  'base',
  'small.en',
  'small',
  'medium.en',
  'medium',
  'large-v1',
  'large-v2',
  'large-v3',
  'large',
  'large-v3-turbo',
  'turbo'
] as const;
export const FASTER_WHISPER_MODEL_OPTIONS = [
  'tiny.en',
  'tiny',
  'base.en',
  'base',
  'small.en',
  'small',
  'medium.en',
  'medium',
  'large-v1',
  'large-v2',
  'large-v3',
  'large',
  'distil-small.en',
  'distil-medium.en',
  'distil-large-v2',
  'distil-large-v3',
  'distil-large-v3.5',
  'large-v3-turbo',
  'turbo'
] as const;
// whisper.cpp uses GGML models; CTranslate2 distil models are not interchangeable.
export const WHISPER_CPP_MODEL_OPTIONS = OPENAI_WHISPER_MODEL_OPTIONS;
export const DEFAULT_LOG_LEVEL = 'info';
export const DEFAULT_TRANSLATION_REQUEST_LIMIT = 2;
export const DEFAULT_TRANSLATION_MAX_TEXT_LENGTH = 3600;
export const DEFAULT_TRANSLATION_MAX_GROUP_LENGTH = 18;
export const DEFAULT_TRANSLATION_TEMPERATURE = 0.2;

export const TRANSCRIPTION_LANGUAGE_OPTIONS: ReadonlyArray<{
  value: TranscriptionLanguage;
  label: string;
  description: string;
}> = [
  { value: 'auto', label: '自动检测', description: '由 Whisper 判断音频语言' },
  { value: 'zh', label: '中文（普通话）', description: 'Chinese / Mandarin' },
  { value: 'en', label: '英语', description: 'English' },
  { value: 'yue', label: '粤语', description: 'Cantonese' },
  { value: 'ja', label: '日语', description: 'Japanese' },
  { value: 'ko', label: '韩语', description: 'Korean' },
  { value: 'es', label: '西班牙语', description: 'Spanish' },
  { value: 'fr', label: '法语', description: 'French' },
  { value: 'de', label: '德语', description: 'German' },
  { value: 'ru', label: '俄语', description: 'Russian' },
  { value: 'pt', label: '葡萄牙语', description: 'Portuguese' },
  { value: 'it', label: '意大利语', description: 'Italian' },
  { value: 'ar', label: '阿拉伯语', description: 'Arabic' },
  { value: 'hi', label: '印地语', description: 'Hindi' },
  { value: 'th', label: '泰语', description: 'Thai' },
  { value: 'vi', label: '越南语', description: 'Vietnamese' },
  { value: 'id', label: '印度尼西亚语', description: 'Indonesian' },
  { value: 'tr', label: '土耳其语', description: 'Turkish' },
  { value: 'pl', label: '波兰语', description: 'Polish' },
  { value: 'nl', label: '荷兰语', description: 'Dutch' },
  { value: 'uk', label: '乌克兰语', description: 'Ukrainian' }
];
