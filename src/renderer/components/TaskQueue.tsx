import { AnimatePresence, motion } from 'framer-motion';

import type { TaskRecord } from '../../shared/types';
import { fadeUpVariants, staggerContainerVariants } from '../motion';
import {
  describeTaskMode,
  describeTaskLanguage,
  formatDateTime,
  formatDuration,
  formatProgressPercent,
  getReadableName,
  normalizeUiText,
  statusLabels,
  statusTones,
  truncate
} from '../utils';
import Icon from './Icon';

interface TaskQueueProps {
  tasks: TaskRecord[];
  selectedTaskId?: string;
  onSelect: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onCancel: (taskId: string) => void;
  onRemove: (taskId: string) => void;
}

const activeStatuses = new Set<TaskRecord['status']>([
  'queued',
  'downloading',
  'preprocessing',
  'transcribing',
  'translating'
]);
const retryableStatuses = new Set<TaskRecord['status']>(['failed', 'cancelled', 'partial']);

const TaskQueue = ({
  tasks,
  selectedTaskId,
  onSelect,
  onRetry,
  onCancel,
  onRemove
}: TaskQueueProps): React.JSX.Element => {
  if (tasks.length === 0) {
    return (
      <section aria-label="任务队列" className="task-queue">
        <div className="empty-state task-queue__empty">
          <span aria-hidden="true" className="empty-state__icon">
            <Icon name="queue" size={24} />
          </span>
          <strong>队列还是空的</strong>
          <p>粘贴链接或选择本地文件，任务会在这里按加入顺序执行。</p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={`任务队列，共 ${tasks.length} 项`} className="task-queue">
      <motion.div
        animate="visible"
        aria-label="任务列表"
        className="task-queue__list"
        initial="hidden"
        role="list"
        variants={staggerContainerVariants}
      >
        <AnimatePresence initial={false}>
          {tasks.map((task) => {
            const selected = selectedTaskId === task.id;
            const active = activeStatuses.has(task.status);
            const retryable = retryableStatuses.has(task.status);
            const readableName = getReadableName(task);
            const statusLabel = statusLabels[task.status];
            const hasProgress =
              typeof task.progressPercent === 'number' && Number.isFinite(task.progressPercent);
            const progressValue = hasProgress
              ? Math.min(100, Math.max(0, task.progressPercent ?? 0))
              : 0;
            const progressPercent = formatProgressPercent(hasProgress ? progressValue : undefined);
            const progressMessage = normalizeUiText(task.progressMessage) || '等待任务启动';
            const metaTags = [
              task.sourceType === 'link' ? '链接任务' : '本地文件',
              describeTaskMode(task),
              task.translateToChinese && task.downloadBehavior !== 'downloadOnly' ? '含中文翻译' : undefined,
              describeTaskLanguage(task),
              typeof task.mediaInfo?.durationSeconds === 'number'
                ? `时长 ${formatDuration(task.mediaInfo.durationSeconds)}`
                : undefined,
              `创建 ${formatDateTime(task.createdAt)}`,
              task.attempts > 1 ? `已重试 ${task.attempts - 1} 次` : undefined
            ].filter((value): value is string => Boolean(value));

            return (
              <motion.article
                aria-label={`${readableName}，${statusLabel}`}
                className={`task-card${selected ? ' is-selected' : ''}`}
                exit="exit"
                key={task.id}
                layout
                onClick={() => onSelect(task.id)}
                role="listitem"
                variants={fadeUpVariants}
              >
                <button
                  aria-label={`查看任务“${readableName}”，当前状态：${statusLabel}`}
                  aria-pressed={selected}
                  className="task-card__selection"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(task.id);
                  }}
                  title={`查看任务：${readableName}`}
                  type="button"
                >
                  <span aria-hidden="true" className="task-card__source-icon">
                    <Icon name={task.sourceType === 'link' ? 'link' : 'file'} size={18} />
                  </span>
                  <span className="task-card__content">
                    <span className="task-card__title-row">
                      <strong title={readableName}>{truncate(readableName, 46)}</strong>
                      <span
                        aria-label={`状态：${statusLabel}`}
                        className={`status-badge ${statusTones[task.status]}`}
                        title={`任务状态：${statusLabel}`}
                      >
                        <span aria-hidden="true" className="status-badge__dot" />
                        {statusLabel}
                      </span>
                    </span>
                    <span className="task-card__input" title={task.input}>
                      {truncate(task.input, 82)}
                    </span>
                    <span aria-label="任务信息" className="task-card__metadata" role="list">
                      {metaTags.map((value, index) => (
                        <span className="meta-tag" key={`${value}-${index}`} role="listitem" title={value}>
                          {value}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>

                <div className="task-card__progress">
                  <div className="task-card__progress-heading">
                    <span title={progressMessage}>{progressMessage}</span>
                    <strong>{progressPercent ?? (active ? '处理中' : statusLabel)}</strong>
                  </div>
                  <div
                    aria-label={`${readableName}的处理进度`}
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={hasProgress ? progressValue : undefined}
                    aria-valuetext={progressPercent ?? progressMessage}
                    className={`task-card__progress-track${active ? ' is-active' : ''}`}
                    role="progressbar"
                    title={progressPercent ? `处理进度 ${progressPercent}` : progressMessage}
                  >
                    <motion.span
                      animate={{ width: `${progressValue}%` }}
                      className="task-card__progress-value"
                      initial={false}
                      transition={{ duration: 0.12, ease: 'linear' }}
                    />
                  </div>
                </div>

                <div aria-label="任务操作" className="task-card__actions" role="group">
                  {retryable ? (
                    <button
                      aria-label={`重试任务“${readableName}”`}
                      className="task-card__action"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRetry(task.id);
                      }}
                      title="重新执行此任务"
                      type="button"
                    >
                      <Icon aria-hidden="true" name="retry" size={16} />
                      <span>重试</span>
                    </button>
                  ) : null}

                  {active ? (
                    <button
                      aria-label={`取消任务“${readableName}”`}
                      className="task-card__action task-card__action--danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancel(task.id);
                      }}
                      title="取消正在执行的任务"
                      type="button"
                    >
                      <Icon aria-hidden="true" name="stop" size={16} />
                      <span>取消</span>
                    </button>
                  ) : null}

                  {!active ? (
                    <button
                      aria-label={`从队列移除任务“${readableName}”`}
                      className="task-card__action task-card__action--danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(task.id);
                      }}
                      title="从当前队列移除此任务"
                      type="button"
                    >
                      <Icon aria-hidden="true" name="trash" size={16} />
                      <span>移除</span>
                    </button>
                  ) : null}
                </div>
              </motion.article>
            );
          })}
        </AnimatePresence>
      </motion.div>
    </section>
  );
};

export default TaskQueue;
