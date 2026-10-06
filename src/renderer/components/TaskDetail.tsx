import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import type { ExportFileKind, HistoryRecord, TaskRecord, TranscriptSegment } from '../../shared/types';
import { fadeUpVariants, paneSwitchVariants, tabIndicatorTransition } from '../motion';
import {
  describeTaskMode,
  describeTaskLanguage,
  formatDateTime,
  formatDuration,
  formatLongDateTime,
  formatProgressPercent,
  getReadableName,
  isTaskActive,
  normalizeUiText,
  statusLabels,
  statusTones,
  videoQualityLabels
} from '../utils';
import Icon from './Icon';
import type { IconName } from './Icon';

interface TaskDetailProps {
  task?: TaskRecord;
  historyRecord?: HistoryRecord;
  onCopy: (text: string, label: string) => void;
  onDeleteDirectory: (taskId: string) => void;
  onOpenOutputDir: (taskId: string) => void;
  onOpenSource: (taskId: string) => void;
  onExport: (taskId: string, kind: ExportFileKind) => void;
  onRevealPath: (targetPath: string) => void;
  onRemoveHistory: (historyId: string) => void;
}

type DetailPanelKey = 'transcript' | 'translation' | 'logs';
type ResultPanelKey = Exclude<DetailPanelKey, 'logs'>;
type ResultViewMode = 'full' | 'timeline';

interface ExportOption {
  kind: ExportFileKind;
  label: string;
  fileKey: keyof TaskRecord['outputFiles'];
}

interface ResultPanelConfiguration {
  copyLabel: string;
  copyToastLabel: string;
  emptyMessage: string;
  exportLabel: string;
  exports: ExportOption[];
  icon: IconName;
  idleMessage: string;
  segmentsKey: 'transcriptSegments' | 'translationSegments';
  textKey: 'transcriptText' | 'translationText';
  title: string;
  eyebrow: string;
}

interface ResultPanelProps {
  kind: ResultPanelKey;
  onCopy: TaskDetailProps['onCopy'];
  onExport: TaskDetailProps['onExport'];
  onViewModeChange: (mode: ResultViewMode) => void;
  task: TaskRecord;
  viewMode: ResultViewMode;
}

interface LogsPanelProps {
  task: TaskRecord;
}

interface HistoryDetailProps {
  historyRecord: HistoryRecord;
  onDeleteDirectory: TaskDetailProps['onDeleteDirectory'];
  onRemoveHistory: TaskDetailProps['onRemoveHistory'];
  onRevealPath: TaskDetailProps['onRevealPath'];
}

interface DetailNoticeProps {
  code?: string;
  message: string;
  title: string;
  tone: 'danger' | 'warning';
}

const transcriptExports: ExportOption[] = [
  { kind: 'transcriptTxt', label: 'TXT', fileKey: 'transcriptTxt' },
  { kind: 'transcriptSrt', label: 'SRT', fileKey: 'transcriptSrt' },
  { kind: 'transcriptVtt', label: 'VTT', fileKey: 'transcriptVtt' },
  { kind: 'transcriptJson', label: 'JSON', fileKey: 'transcriptJson' }
];

const translationExports: ExportOption[] = [
  { kind: 'translationTxt', label: 'TXT', fileKey: 'translationTxt' },
  { kind: 'translationSrt', label: 'SRT', fileKey: 'translationSrt' },
  { kind: 'translationVtt', label: 'VTT', fileKey: 'translationVtt' },
  { kind: 'translationJson', label: 'JSON', fileKey: 'translationJson' }
];

const resultPanelConfigurations: Record<ResultPanelKey, ResultPanelConfiguration> = {
  transcript: {
    copyLabel: '复制原文',
    copyToastLabel: '原文',
    emptyMessage: '当前任务只下载了媒体文件，没有进入转写流程。',
    exportLabel: '导出原文',
    exports: transcriptExports,
    icon: 'waveform',
    idleMessage: '任务完成后，转写全文会出现在这里。',
    segmentsKey: 'transcriptSegments',
    textKey: 'transcriptText',
    title: '转写结果',
    eyebrow: '原文'
  },
  translation: {
    copyLabel: '复制译文',
    copyToastLabel: '中文译文',
    emptyMessage: '当前任务没有执行转写，因此也没有生成译文。',
    exportLabel: '导出译文',
    exports: translationExports,
    icon: 'translate',
    idleMessage: '开启中文翻译后，完整译文会出现在这里。',
    segmentsKey: 'translationSegments',
    textKey: 'translationText',
    title: '翻译结果',
    eyebrow: '中文'
  }
};

const detailTabs: Array<{ id: DetailPanelKey; icon: IconName; label: string }> = [
  { id: 'transcript', icon: 'waveform', label: '原文' },
  { id: 'translation', icon: 'translate', label: '中文' },
  { id: 'logs', icon: 'terminal', label: '日志' }
];

const initialResultViews: Record<ResultPanelKey, ResultViewMode> = {
  transcript: 'full',
  translation: 'full'
};

function formatTimelineTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalMilliseconds = Math.round(safeSeconds * 1000);
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const displaySeconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const displayMinutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const secondPart = String(displaySeconds).padStart(2, '0');
  const minutePart = String(displayMinutes).padStart(2, '0');
  let timestamp = `${minutePart}:${secondPart}`;

  if (hours > 0) {
    timestamp = `${String(hours).padStart(2, '0')}:${minutePart}:${secondPart}`;
  }

  if (milliseconds > 0) {
    timestamp += `.${String(milliseconds).padStart(3, '0')}`;
  }

  return timestamp;
}

function mergeSegmentText(text: string | undefined, segments: TranscriptSegment[]): string {
  if (text?.trim()) {
    return text;
  }

  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join('\n');
}

function getSourceButtonLabel(task: TaskRecord): string {
  if (task.sourceType === 'file') {
    return '定位原始文件';
  }

  if (task.outputFiles.downloadedMedia || task.outputFiles.audio) {
    return '定位媒体文件';
  }

  if (task.outputFiles.sourceMedia) {
    return '定位源文件';
  }

  return '定位任务文件';
}

function DetailNotice({ code, message, title, tone }: DetailNoticeProps): React.JSX.Element {
  return (
    <div aria-live={tone === 'danger' ? 'assertive' : 'polite'} className={`notice detail-notice ${tone}`} role="alert">
      <span aria-hidden="true" className="detail-notice-icon">
        <Icon name="warning" size={18} />
      </span>
      <div className="detail-notice-copy">
        <div className="detail-notice-heading">
          <strong>{title}</strong>
          {code ? <code className="detail-notice-code">{code}</code> : null}
        </div>
        <p>{message}</p>
      </div>
    </div>
  );
}

function DetailEmptyState(): React.JSX.Element {
  return (
    <section aria-labelledby="detail-empty-title" className="detail-shell detail-shell-empty">
      <motion.article
        animate="visible"
        className="detail-panel-surface detail-empty-card glass-panel"
        initial="hidden"
        variants={fadeUpVariants}
      >
        <div aria-hidden="true" className="detail-empty-visual">
          <span className="detail-empty-orb">
            <Icon name="waveform" size={34} />
          </span>
          <div className="detail-empty-wave">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="detail-empty-copy">
          <p className="section-eyebrow">结果工作区</p>
          <h2 id="detail-empty-title">选择一个任务开始查看</h2>
          <p>从队列或历史记录中选择任务，即可查看转写全文、逐句时间轴、中文译文和处理日志。</p>
        </div>
      </motion.article>
    </section>
  );
}

function HistoryDetail({
  historyRecord,
  onDeleteDirectory,
  onRemoveHistory,
  onRevealPath
}: HistoryDetailProps): React.JSX.Element {
  const historyMetaTags = [
    historyRecord.sourceType === 'link' ? '链接任务' : '本地文件',
    historyRecord.downloadBehavior && historyRecord.videoQuality
      ? describeTaskMode({
          downloadBehavior: historyRecord.downloadBehavior,
          videoQuality: historyRecord.videoQuality
        })
      : undefined,
    historyRecord.translateToChinese && historyRecord.downloadBehavior !== 'downloadOnly' ? '含中文翻译' : undefined,
    describeTaskLanguage(historyRecord),
    typeof historyRecord.durationSeconds === 'number'
      ? `时长 ${formatDuration(historyRecord.durationSeconds)}`
      : undefined,
    `创建 ${formatDateTime(historyRecord.createdAt)}`,
    `完成 ${formatDateTime(historyRecord.finishedAt)}`
  ].filter((item): item is string => Boolean(item));

  let summary = '这条记录只保留了任务摘要，原输出目录当前不可用。';
  if (historyRecord.outputDir) {
    summary = '任务结果仍保存在输出目录中，可以直接打开目录查看转写、字幕和日志文件。';
  }

  const openOutputDirectory = (): void => {
    if (historyRecord.outputDir) {
      onRevealPath(historyRecord.outputDir);
    }
  };

  return (
    <section aria-labelledby="history-detail-title" className="detail-shell history-detail-shell">
      <motion.article
        animate="visible"
        className="detail-hero history-detail-hero glass-panel"
        initial="hidden"
        variants={fadeUpVariants}
      >
        <div className="detail-hero-header">
          <div className="detail-heading">
            <span aria-hidden="true" className="detail-heading-icon">
              <Icon name="history" size={22} />
            </span>
            <div className="detail-title-wrap">
              <p className="section-eyebrow">历史记录</p>
              <h2 id="history-detail-title" title={getReadableName(historyRecord)}>
                {getReadableName(historyRecord)}
              </h2>
              <p className="detail-input">任务已离开当前队列，这里保留它的完成状态和输出位置。</p>
            </div>
          </div>
          <span className={`status-badge detail-status ${statusTones[historyRecord.status]}`}>
            {statusLabels[historyRecord.status]}
          </span>
        </div>

        <ul aria-label="历史任务信息" className="queue-meta-tags detail-meta-tags detail-metadata">
          {historyMetaTags.map((item, index) => (
            <li className="meta-tag detail-meta-item" key={`${item}-${index}`}>
              {item}
            </li>
          ))}
        </ul>

        <div aria-label="历史任务操作" className="detail-actions detail-action-bar" role="group">
          <button
            className="ghost-button detail-action-button"
            disabled={!historyRecord.outputDir}
            onClick={openOutputDirectory}
            type="button"
          >
            <Icon name="folder" size={17} />
            <span>打开输出目录</span>
          </button>
          <button
            className="ghost-button detail-action-button danger-subtle"
            disabled={!historyRecord.outputDir}
            onClick={() => onDeleteDirectory(historyRecord.id)}
            type="button"
          >
            <Icon name="trash" size={17} />
            <span>删除输出目录</span>
          </button>
          <button
            className="ghost-button detail-action-button"
            onClick={() => onRemoveHistory(historyRecord.id)}
            type="button"
          >
            <Icon name="close" size={17} />
            <span>移除记录</span>
          </button>
        </div>

        {historyRecord.error ? (
          <div className="detail-notices">
            <DetailNotice message={normalizeUiText(historyRecord.error)} title="任务未完整结束" tone="warning" />
          </div>
        ) : null}
      </motion.article>

      <motion.article
        animate="visible"
        className="detail-panel-surface detail-workspace history-summary glass-panel"
        initial="hidden"
        variants={fadeUpVariants}
      >
        <div className="panel-toolbar detail-panel-toolbar history-summary-header">
          <div className="detail-panel-heading">
            <span aria-hidden="true" className="detail-panel-icon">
              <Icon name="info" size={20} />
            </span>
            <div>
              <p className="section-eyebrow">任务归档</p>
              <h3>历史摘要</h3>
            </div>
          </div>
        </div>
        <div className="result-viewer detail-scroll-view history-summary-content">
          <p>{summary}</p>
          {historyRecord.outputDir ? (
            <button className="history-path" onClick={openOutputDirectory} title={historyRecord.outputDir} type="button">
              <Icon name="folder" size={16} />
              <span>{historyRecord.outputDir}</span>
              <Icon name="external" size={15} />
            </button>
          ) : null}
        </div>
      </motion.article>
    </section>
  );
}

function ResultTimeline({ segments }: { segments: TranscriptSegment[] }): React.JSX.Element {
  return (
    <ol aria-label="分段时间轴" className="result-timeline">
      {segments.map((segment, index) => {
        const start = formatTimelineTime(segment.start);
        const end = formatTimelineTime(segment.end);

        return (
          <li className="result-segment" key={`${segment.id}-${segment.start}-${index}`}>
            <div aria-label={`从 ${start} 到 ${end}`} className="result-segment-time">
              <Icon name="clock" size={15} />
              <span>{start}</span>
              <span aria-hidden="true" className="result-segment-separator">
                —
              </span>
              <span>{end}</span>
            </div>
            <p className="result-segment-text">{segment.text}</p>
          </li>
        );
      })}
    </ol>
  );
}

function ResultPanel({
  kind,
  onCopy,
  onExport,
  onViewModeChange,
  task,
  viewMode
}: ResultPanelProps): React.JSX.Element {
  const configuration = resultPanelConfigurations[kind];
  const segments = task[configuration.segmentsKey] ?? [];
  const resultText = mergeSegmentText(task[configuration.textKey], segments);
  const hasTimeline = segments.length > 0;
  const showingTimeline = hasTimeline && viewMode === 'timeline';
  let resultContent: ReactNode;

  if (showingTimeline) {
    resultContent = <ResultTimeline segments={segments} />;
  } else if (resultText) {
    resultContent = <pre className="result-viewer result-text">{resultText}</pre>;
  } else {
    const emptyMessage = task.downloadBehavior === 'downloadOnly' ? configuration.emptyMessage : configuration.idleMessage;
    resultContent = (
      <div className="result-empty">
        <span aria-hidden="true" className="result-empty-icon">
          <Icon name={configuration.icon} size={25} />
        </span>
        <strong>还没有可显示的内容</strong>
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <motion.section
      animate="active"
      aria-labelledby={`task-detail-tab-${kind}`}
      className="detail-panel-body detail-panel result-panel"
      exit="inactive"
      id={`task-detail-panel-${kind}`}
      initial="inactive"
      key={kind}
      role="tabpanel"
      tabIndex={0}
      variants={paneSwitchVariants}
    >
      <div className="panel-toolbar detail-panel-toolbar result-panel-toolbar">
        <div className="detail-panel-heading">
          <span aria-hidden="true" className="detail-panel-icon">
            <Icon name={configuration.icon} size={20} />
          </span>
          <div>
            <p className="section-eyebrow">{configuration.eyebrow}</p>
            <h3>{configuration.title}</h3>
          </div>
        </div>

        <div className="result-panel-actions">
          {hasTimeline ? (
            <div aria-label={`${configuration.eyebrow}查看方式`} className="result-view-switch" role="group">
              <button
                aria-pressed={viewMode === 'full'}
                className={`result-view-button ${viewMode === 'full' ? 'active' : ''}`}
                onClick={() => onViewModeChange('full')}
                type="button"
              >
                <Icon name="file" size={15} />
                <span>全文</span>
              </button>
              <button
                aria-pressed={viewMode === 'timeline'}
                className={`result-view-button ${viewMode === 'timeline' ? 'active' : ''}`}
                onClick={() => onViewModeChange('timeline')}
                type="button"
              >
                <Icon name="clock" size={15} />
                <span>时间轴</span>
              </button>
            </div>
          ) : null}

          <button
            className="ghost-button result-copy-button"
            disabled={!resultText}
            onClick={() => resultText && onCopy(resultText, configuration.copyToastLabel)}
            type="button"
          >
            <Icon name="copy" size={16} />
            <span>{configuration.copyLabel}</span>
          </button>
        </div>
      </div>

      <div className="export-toolbar result-export-bar">
        <span className="export-label result-export-label">{configuration.exportLabel}</span>
        <div aria-label={configuration.exportLabel} className="export-button-group result-export-actions" role="group">
          {configuration.exports.map((item) => (
            <button
              className="ghost-button result-export-button"
              disabled={!task.outputFiles[item.fileKey]}
              key={item.kind}
              onClick={() => onExport(task.id, item.kind)}
              type="button"
            >
              <Icon name="download" size={14} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div aria-live="polite" className={`detail-scroll-view result-content ${showingTimeline ? 'timeline-view' : 'full-view'}`}>
        {resultContent}
      </div>
    </motion.section>
  );
}

function LogsPanel({ task }: LogsPanelProps): React.JSX.Element {
  return (
    <motion.section
      animate="active"
      aria-labelledby="task-detail-tab-logs"
      className="detail-panel-body detail-panel log-panel"
      exit="inactive"
      id="task-detail-panel-logs"
      initial="inactive"
      key="logs"
      role="tabpanel"
      tabIndex={0}
      variants={paneSwitchVariants}
    >
      <div className="panel-toolbar detail-panel-toolbar log-panel-toolbar">
        <div className="detail-panel-heading">
          <span aria-hidden="true" className="detail-panel-icon">
            <Icon name="terminal" size={20} />
          </span>
          <div>
            <p className="section-eyebrow">运行记录</p>
            <h3>处理日志</h3>
          </div>
        </div>
        <span className="log-count" aria-label={`共 ${task.logs.length} 条日志`}>
          {task.logs.length} 条
        </span>
      </div>

      <div className="logs-list detail-scroll-view log-content">
        {task.logs.length === 0 ? (
          <div className="empty-state log-empty">
            <span aria-hidden="true" className="log-empty-icon">
              <Icon name="terminal" size={24} />
            </span>
            <strong>暂无处理日志</strong>
            <p>任务开始后，下载、预处理、转写和翻译过程会依次记录在这里。</p>
          </div>
        ) : (
          <ol className="log-list">
            {task.logs.map((entry, index) => (
              <li className={`log-row log-entry is-${entry.level}`} key={`${entry.timestamp}-${index}`}>
                <div className="log-entry-header">
                  <time className="log-entry-time" dateTime={entry.timestamp}>
                    {formatLongDateTime(entry.timestamp)}
                  </time>
                  <strong className="log-entry-level">{entry.level.toUpperCase()}</strong>
                </div>
                <p className="log-entry-message">{normalizeUiText(entry.message)}</p>
                {entry.context ? (
                  <pre className="log-entry-context">
                    <code>{entry.context}</code>
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </motion.section>
  );
}

const TaskDetail = ({
  task,
  historyRecord,
  onCopy,
  onDeleteDirectory,
  onOpenOutputDir,
  onOpenSource,
  onExport,
  onRevealPath,
  onRemoveHistory
}: TaskDetailProps): React.JSX.Element => {
  const [activePanel, setActivePanel] = useState<DetailPanelKey>('transcript');
  const [resultViews, setResultViews] = useState<Record<ResultPanelKey, ResultViewMode>>(initialResultViews);

  useEffect(() => {
    setActivePanel('transcript');
    setResultViews(initialResultViews);
  }, [historyRecord?.id, task?.id]);

  if (!task) {
    if (historyRecord) {
      return (
        <HistoryDetail
          historyRecord={historyRecord}
          onDeleteDirectory={onDeleteDirectory}
          onRemoveHistory={onRemoveHistory}
          onRevealPath={onRevealPath}
        />
      );
    }

    return <DetailEmptyState />;
  }

  const currentTask = task;
  const progressBarActive = ['queued', 'downloading', 'preprocessing', 'transcribing', 'translating'].includes(
    currentTask.status
  );
  let progressValue = currentTask.progressPercent ?? 0;
  if (currentTask.status === 'completed' && currentTask.progressPercent === undefined) {
    progressValue = 100;
  }
  progressValue = Math.min(100, Math.max(0, progressValue));

  const progressPercent = formatProgressPercent(progressValue) ?? `${Math.round(progressValue)}%`;
  const progressMessage = normalizeUiText(currentTask.progressMessage) || '等待任务启动';
  const sourceButtonLabel = getSourceButtonLabel(currentTask);
  const visibleError = currentTask.error ? normalizeUiText(currentTask.error) : undefined;
  const visibleWarning = currentTask.warning ? normalizeUiText(currentTask.warning) : undefined;
  const visibleFallback = currentTask.mediaInfo?.qualityFallbackMessage
    ? normalizeUiText(currentTask.mediaInfo.qualityFallbackMessage)
    : undefined;

  const taskMetaTags = [
    currentTask.sourceType === 'link' ? '链接任务' : '本地文件',
    describeTaskMode(currentTask),
    currentTask.translateToChinese && currentTask.downloadBehavior !== 'downloadOnly' ? '含中文翻译' : undefined,
    describeTaskLanguage(currentTask),
    typeof currentTask.mediaInfo?.durationSeconds === 'number'
      ? `时长 ${formatDuration(currentTask.mediaInfo.durationSeconds)}`
      : undefined,
    currentTask.downloadBehavior === 'transcribe' ? `规格 ${videoQualityLabels[currentTask.videoQuality]}` : undefined,
    `创建 ${formatDateTime(currentTask.createdAt)}`,
    `更新 ${formatDateTime(currentTask.updatedAt)}`,
    currentTask.attempts > 1 ? `重试 ${currentTask.attempts - 1} 次` : undefined
  ].filter((item): item is string => Boolean(item));

  const changeResultView = (panel: ResultPanelKey, mode: ResultViewMode): void => {
    setResultViews((currentViews) => ({ ...currentViews, [panel]: mode }));
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentTab: DetailPanelKey): void => {
    const isPrevious = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const isNext = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const isBoundary = event.key === 'Home' || event.key === 'End';

    if (!isPrevious && !isNext && !isBoundary) {
      return;
    }

    event.preventDefault();
    const currentIndex = detailTabs.findIndex((tab) => tab.id === currentTab);
    let nextIndex = currentIndex;

    if (isPrevious) {
      nextIndex = (currentIndex - 1 + detailTabs.length) % detailTabs.length;
    }
    if (isNext) {
      nextIndex = (currentIndex + 1) % detailTabs.length;
    }
    if (event.key === 'Home') {
      nextIndex = 0;
    }
    if (event.key === 'End') {
      nextIndex = detailTabs.length - 1;
    }

    const nextTab = detailTabs[nextIndex];
    setActivePanel(nextTab.id);
    document.getElementById(`task-detail-tab-${nextTab.id}`)?.focus();
  };

  let activePanelContent: ReactNode;
  if (activePanel === 'transcript') {
    activePanelContent = (
      <ResultPanel
        kind="transcript"
        onCopy={onCopy}
        onExport={onExport}
        onViewModeChange={(mode) => changeResultView('transcript', mode)}
        task={currentTask}
        viewMode={resultViews.transcript}
      />
    );
  } else if (activePanel === 'translation') {
    activePanelContent = (
      <ResultPanel
        kind="translation"
        onCopy={onCopy}
        onExport={onExport}
        onViewModeChange={(mode) => changeResultView('translation', mode)}
        task={currentTask}
        viewMode={resultViews.translation}
      />
    );
  } else {
    activePanelContent = <LogsPanel task={currentTask} />;
  }

  return (
    <section aria-labelledby="task-detail-title" className="detail-shell task-detail-shell">
      <motion.article
        animate="visible"
        className="detail-hero task-detail-hero glass-panel"
        initial="hidden"
        variants={fadeUpVariants}
      >
        <div className="detail-hero-header">
          <div className="detail-heading">
            <span aria-hidden="true" className="detail-heading-icon">
              <Icon name={currentTask.sourceType === 'link' ? 'link' : 'file'} size={22} />
            </span>
            <div className="detail-title-wrap">
              <p className="section-eyebrow">当前任务</p>
              <h2 id="task-detail-title" title={getReadableName(currentTask)}>
                {getReadableName(currentTask)}
              </h2>
              <p className="detail-input" title={currentTask.input}>
                {currentTask.input}
              </p>
            </div>
          </div>
          <span className={`status-badge detail-status ${statusTones[currentTask.status]}`}>
            {statusLabels[currentTask.status]}
          </span>
        </div>

        <div
          aria-label="任务处理进度"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progressValue}
          aria-valuetext={`${progressPercent}，${progressMessage}`}
          className="detail-progress detail-progress-card"
          role="progressbar"
        >
          <div className="detail-progress-copy">
            <p>{progressMessage}</p>
            <span className="progress-percent">{progressPercent}</span>
          </div>
          <div aria-hidden="true" className="detail-progress-bar detail-progress-track">
            <span
              className={`detail-progress-fill ${progressBarActive ? 'active' : ''}`}
              style={{ width: `${progressValue}%` }}
            />
          </div>
        </div>

        <ul aria-label="任务信息" className="queue-meta-tags detail-meta-tags detail-metadata">
          {taskMetaTags.map((item, index) => (
            <li className="meta-tag detail-meta-item" key={`${item}-${index}`}>
              {item}
            </li>
          ))}
        </ul>

        <div aria-label="任务文件操作" className="detail-actions detail-action-bar" role="group">
          <button
            className="ghost-button detail-action-button"
            disabled={!currentTask.outputDir}
            onClick={() => onOpenOutputDir(currentTask.id)}
            type="button"
          >
            <Icon name="folder" size={17} />
            <span>打开任务目录</span>
          </button>
          <button
            className="ghost-button detail-action-button danger-subtle"
            disabled={!currentTask.outputDir || isTaskActive(currentTask)}
            onClick={() => onDeleteDirectory(currentTask.id)}
            type="button"
          >
            <Icon name="trash" size={17} />
            <span>删除输出目录</span>
          </button>
          <button
            className="ghost-button detail-action-button"
            onClick={() => onOpenSource(currentTask.id)}
            type="button"
          >
            <Icon name="external" size={17} />
            <span>{sourceButtonLabel}</span>
          </button>
        </div>

        {visibleError || visibleWarning || visibleFallback ? (
          <div className="detail-notices">
            {visibleError ? (
              <DetailNotice code={currentTask.errorCode} message={visibleError} title="任务处理失败" tone="danger" />
            ) : null}
            {visibleWarning ? <DetailNotice message={visibleWarning} title="处理提示" tone="warning" /> : null}
            {visibleFallback ? <DetailNotice message={visibleFallback} title="媒体规格已调整" tone="warning" /> : null}
          </div>
        ) : null}
      </motion.article>

      <motion.article
        animate="visible"
        className="detail-panel-surface detail-workspace glass-panel"
        initial="hidden"
        variants={fadeUpVariants}
      >
        <LayoutGroup id="task-detail-tabs">
          <div aria-label="任务结果" className="detail-panel-tabs detail-tabs" role="tablist">
            {detailTabs.map((tab) => {
              const selected = activePanel === tab.id;
              const badge = tab.id === 'logs' && currentTask.logs.length > 0 ? currentTask.logs.length : undefined;

              return (
                <button
                  aria-controls={`task-detail-panel-${tab.id}`}
                  aria-selected={selected}
                  className={`detail-tab ${selected ? 'active' : ''}`}
                  id={`task-detail-tab-${tab.id}`}
                  key={tab.id}
                  onClick={() => setActivePanel(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                  role="tab"
                  tabIndex={selected ? 0 : -1}
                  type="button"
                >
                  {selected ? (
                    <motion.span
                      aria-hidden="true"
                      className="detail-tab-indicator"
                      layoutId="task-detail-tab-indicator"
                      transition={tabIndicatorTransition}
                    />
                  ) : null}
                  <Icon name={tab.icon} size={16} />
                  <span className="detail-tab-label">{tab.label}</span>
                  {badge ? <span className="detail-tab-badge">{badge}</span> : null}
                </button>
              );
            })}
          </div>
        </LayoutGroup>

        <AnimatePresence initial={false} mode="wait">
          {activePanelContent}
        </AnimatePresence>
      </motion.article>
    </section>
  );
};

export default TaskDetail;
