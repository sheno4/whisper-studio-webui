import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';

import { TRANSCRIPTION_LANGUAGE_OPTIONS } from '../../shared/constants';
import type { DownloadBehavior, TranscriptionLanguage, VideoQualityOption } from '../../shared/types';
import { fadeUpVariants, panelResizeTransition } from '../motion';
import { videoQualityLabels } from '../utils';
import Icon, { type IconName } from './Icon';
import AnimatedSelect from './AnimatedSelect';
import SegmentedControl from './SegmentedControl';

interface InputComposerProps {
  linkInput: string;
  translateNext: boolean;
  downloadBehavior: DownloadBehavior;
  videoQuality: VideoQualityOption;
  transcriptionLanguage: TranscriptionLanguage;
  busy?: boolean;
  onLinkInputChange: (value: string) => void;
  onToggleTranslate: (value: boolean) => void;
  onDownloadBehaviorChange: (value: DownloadBehavior) => void;
  onVideoQualityChange: (value: VideoQualityOption) => void;
  onTranscriptionLanguageChange: (value: TranscriptionLanguage) => void;
  onAddLinks: () => void;
  onPickFiles: () => void;
}

type ProcessingCapability = 'download' | 'transcribe' | 'translate';

interface ProcessingOption {
  value: ProcessingCapability;
  title: string;
  hint: string;
  icon: IconName;
}

const processingOptions: ProcessingOption[] = [
  { value: 'download', title: '保存媒体', hint: '保留链接中的视频或音频', icon: 'download' },
  { value: 'transcribe', title: '生成转写', hint: '识别语音并生成字幕与文本', icon: 'waveform' },
  { value: 'translate', title: '翻译中文', hint: '转写完成后调用翻译服务', icon: 'translate' }
];

const qualityOptions: VideoQualityOption[] = ['best', '1080p', '720p', '480p', 'audio'];
const submitLockDuration = 650;

const InputComposer = ({
  linkInput,
  translateNext,
  downloadBehavior,
  videoQuality,
  transcriptionLanguage,
  busy = false,
  onLinkInputChange,
  onToggleTranslate,
  onDownloadBehaviorChange,
  onVideoQualityChange,
  onTranscriptionLanguageChange,
  onAddLinks,
  onPickFiles
}: InputComposerProps): React.JSX.Element => {
  const [submissionLocked, setSubmissionLocked] = useState(false);
  const composingRef = useRef(false);
  const submissionLockRef = useRef(false);
  const unlockTimerRef = useRef<number | undefined>(undefined);

  const downloadEnabled = downloadBehavior !== 'transcribe';
  const transcriptionEnabled = downloadBehavior !== 'downloadOnly';
  const submissionPending = busy || submissionLocked;
  const canSubmitLinks = linkInput.trim().length > 0 && !submissionPending;
  const canPickFiles = transcriptionEnabled && !submissionPending;
  const languageLabel = TRANSCRIPTION_LANGUAGE_OPTIONS.find(
    (option) => option.value === transcriptionLanguage
  )?.label ?? '自动检测';

  const releaseSubmissionLock = useCallback((): void => {
    window.clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = undefined;
    submissionLockRef.current = false;
    setSubmissionLocked(false);
  }, []);

  useEffect(() => {
    return () => window.clearTimeout(unlockTimerRef.current);
  }, []);

  const submitLinks = useCallback((): void => {
    if (!linkInput.trim() || busy || submissionLockRef.current) {
      return;
    }

    submissionLockRef.current = true;
    setSubmissionLocked(true);

    try {
      onAddLinks();
      unlockTimerRef.current = window.setTimeout(releaseSubmissionLock, submitLockDuration);
    } catch (error) {
      releaseSubmissionLock();
      throw error;
    }
  }, [busy, linkInput, onAddLinks, releaseSubmissionLock]);

  const toggleProcessingCapability = (capability: ProcessingCapability, enabled: boolean): void => {
    if (capability === 'download') {
      onDownloadBehaviorChange(
        enabled
          ? transcriptionEnabled
            ? 'downloadThenTranscribe'
            : 'downloadOnly'
          : 'transcribe'
      );
      return;
    }

    if (capability === 'transcribe') {
      if (!enabled) {
        onToggleTranslate(false);
      }
      onDownloadBehaviorChange(
        enabled
          ? downloadEnabled
            ? 'downloadThenTranscribe'
            : 'transcribe'
          : 'downloadOnly'
      );
      return;
    }

    if (transcriptionEnabled) {
      onToggleTranslate(enabled);
    }
  };

  const summaryText =
    downloadBehavior === 'downloadOnly'
      ? `保存 ${videoQualityLabels[videoQuality]}`
      : downloadBehavior === 'downloadThenTranscribe'
        ? `先保存 ${videoQualityLabels[videoQuality]}，再转写${translateNext ? '并翻译成中文' : ''} · ${languageLabel}`
        : `直接转写${translateNext ? '并翻译成中文' : ''} · ${languageLabel}`;

  return (
    <motion.section
      animate="visible"
      aria-busy={submissionPending}
      aria-labelledby="input-composer-title"
      className="input-composer liquid-glass-panel"
      initial="hidden"
      variants={fadeUpVariants}
    >
      <span aria-hidden="true" className="input-composer__glow liquid-glass-glow" />

      <header className="input-composer__header">
        <div className="input-composer__heading">
          <span aria-hidden="true" className="input-composer__heading-icon">
            <Icon name="upload" size={20} />
          </span>
          <div>
            <p className="section-eyebrow">新建任务</p>
            <h2 id="input-composer-title">导入链接或文件</h2>
            <p>粘贴分享内容，或从电脑选择媒体文件。</p>
          </div>
        </div>
        <kbd className="input-composer__shortcut">Enter</kbd>
      </header>

      <div className="input-composer__source-field">
        <label className="input-composer__source-label" htmlFor="media-link-input">
          <span>媒体链接</span>
          <small>支持一次粘贴多个链接或完整分享文案</small>
        </label>
        <div className="input-composer__textarea-shell">
          <span aria-hidden="true" className="input-composer__textarea-icon">
            <Icon name="link" size={19} />
          </span>
          <textarea
            aria-describedby="media-link-input-help"
            autoCapitalize="off"
            autoCorrect="off"
            className="input-composer__textarea"
            id="media-link-input"
            placeholder="粘贴抖音、YouTube、B 站等媒体链接…"
            rows={4}
            spellCheck={false}
            value={linkInput}
            onChange={(event) => onLinkInputChange(event.target.value)}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onKeyDown={(event) => {
              const isComposing =
                composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;

              if (isComposing || event.key !== 'Enter' || event.shiftKey) {
                return;
              }

              event.preventDefault();
              submitLinks();
            }}
          />
        </div>
        <div className="input-composer__input-help" id="media-link-input-help">
          <span>自动识别分享文案中的链接</span>
          <span>
            <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行
          </span>
        </div>
      </div>

      <motion.div className="input-composer__workflow" layout transition={panelResizeTransition}>
        <fieldset
          aria-describedby="processing-capabilities-help"
          className="input-composer__capability-fieldset"
        >
          <legend>处理功能</legend>
          <p className="input-composer__capability-help" id="processing-capabilities-help">
            按需勾选；保存媒体与生成转写至少保留一项。
          </p>
          <div className="input-composer__capability-list">
            {processingOptions.map((option) => {
              const checked =
                option.value === 'download'
                  ? downloadEnabled
                  : option.value === 'transcribe'
                    ? transcriptionEnabled
                    : transcriptionEnabled && translateNext;
              const disabled = option.value === 'translate' && !transcriptionEnabled;

              return (
                <label
                  className={`input-composer__capability${checked ? ' is-checked' : ''}${disabled ? ' is-disabled' : ''}`}
                  key={option.value}
                  title={disabled ? '需要先勾选生成转写' : `${option.title}：${option.hint}`}
                >
                  <span aria-hidden="true" className="input-composer__capability-icon">
                    <Icon name={option.icon} size={18} />
                  </span>
                  <span className="input-composer__capability-copy">
                    <strong>{option.title}</strong>
                    <small>{disabled ? '需要先生成转写' : option.hint}</small>
                  </span>
                  <input
                    checked={checked}
                    className="input-composer__capability-input"
                    disabled={disabled}
                    onChange={(event) => toggleProcessingCapability(option.value, event.target.checked)}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="input-composer__capability-check">
                    {checked ? <Icon name="check" size={14} /> : null}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <AnimatePresence initial={false} mode="popLayout">
          {transcriptionEnabled ? (
            <motion.fieldset
              animate="visible"
              className="input-composer__conditional-option input-composer__language-option"
              exit="exit"
              initial="hidden"
              key="transcription-language"
              layout
              variants={fadeUpVariants}
            >
              <legend>
                <Icon aria-hidden="true" name="waveform" size={17} />
                音频语言
              </legend>
              <AnimatedSelect
                buttonClassName="input-composer__language-trigger"
                className="input-composer__language-select"
                id="transcription-language"
                menuClassName="input-composer__language-menu"
                onChange={onTranscriptionLanguageChange}
                options={TRANSCRIPTION_LANGUAGE_OPTIONS}
                value={transcriptionLanguage}
              />
              <p className="input-composer__language-help">
                已知语言时直接指定可跳过自动检测；混合语言建议保持自动。
              </p>
            </motion.fieldset>
          ) : null}

          {downloadEnabled ? (
            <motion.fieldset
              animate="visible"
              className="input-composer__conditional-option"
              exit="exit"
              initial="hidden"
              key="download-quality"
              layout
              variants={fadeUpVariants}
            >
              <legend>
                <Icon aria-hidden="true" name="download" size={17} />
                下载规格
              </legend>
              <SegmentedControl
                allowWrap
                ariaLabel="下载规格"
                className="input-composer__quality-selector"
                id="download-quality-tabs"
                items={qualityOptions.map((option) => ({
                  value: option,
                  label: videoQualityLabels[option],
                  title: `下载 ${videoQualityLabels[option]}`
                }))}
                onChange={onVideoQualityChange}
                stretch
                value={videoQuality}
              />
            </motion.fieldset>
          ) : null}
        </AnimatePresence>

        <motion.div
          aria-live="polite"
          className="input-composer__summary"
          layout
          transition={panelResizeTransition}
        >
          <span aria-hidden="true" className="input-composer__summary-icon">
            <Icon name="sparkles" size={18} />
          </span>
          <span>
            <small>本次将执行</small>
            <strong>{summaryText}</strong>
          </span>
        </motion.div>

        <motion.div className="input-composer__actions" layout transition={panelResizeTransition}>
          <button
            aria-disabled={!canSubmitLinks}
            className="primary-button input-composer__submit"
            disabled={!canSubmitLinks}
            onClick={submitLinks}
            title={linkInput.trim() ? '将链接加入任务队列' : '请先粘贴媒体链接'}
            type="button"
          >
            <Icon aria-hidden="true" name={submissionPending ? 'clock' : 'queue'} size={18} />
            {submissionPending ? '正在加入…' : '加入链接队列'}
          </button>
          <button
            aria-label="从电脑选择本地媒体文件"
            className="ghost-button input-composer__file-picker"
            disabled={!canPickFiles}
            onClick={onPickFiles}
            title={transcriptionEnabled ? '选择本地音频或视频文件' : '本地文件需要勾选生成转写'}
            type="button"
          >
            <Icon aria-hidden="true" name="folder" size={18} />
            选择本地文件
          </button>
        </motion.div>

        <p className="input-composer__footnote">
          <Icon aria-hidden="true" name="info" size={15} />
          保存媒体与下载规格仅对链接生效；本地文件需要启用生成转写。
        </p>
      </motion.div>
    </motion.section>
  );
};

export default InputComposer;
