import { AnimatePresence, motion } from 'framer-motion';

import type { HistoryRecord } from '../../shared/types';
import { fadeUpVariants, staggerContainerVariants } from '../motion';
import {
  describeTaskLanguage,
  describeTaskMode,
  formatDuration,
  getReadableName,
  normalizeUiText,
  statusLabels,
  statusTones,
  truncate
} from '../utils';
import Icon from './Icon';

interface HistoryListProps {
  history: HistoryRecord[];
  selectedHistoryId?: string;
  onSelect: (historyId: string) => void;
  onReveal: (outputDir: string) => void;
  onRemove: (historyId: string) => void;
}

interface HistoryGroup {
  key: string;
  label: string;
  items: HistoryRecord[];
}

const dateKey = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const historyTimestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const historyGroupLabel = (value: Date, now = new Date()): string => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const dayDifference = Math.round((today.getTime() - target.getTime()) / 86_400_000);

  if (dayDifference === 0) {
    return '今天';
  }
  if (dayDifference === 1) {
    return '昨天';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: value.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(value);
};

const formatHistoryTime = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '--:--';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(parsed);
};

const groupHistory = (history: HistoryRecord[]): HistoryGroup[] => {
  const groups = new Map<string, HistoryGroup>();
  const sorted = [...history].sort(
    (left, right) => historyTimestamp(right.finishedAt) - historyTimestamp(left.finishedAt)
  );

  for (const item of sorted) {
    const finishedAt = new Date(item.finishedAt);
    const validDate = !Number.isNaN(finishedAt.getTime());
    const key = validDate ? dateKey(finishedAt) : 'unknown';
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(key, {
      key,
      label: validDate ? historyGroupLabel(finishedAt) : '日期未知',
      items: [item]
    });
  }

  return Array.from(groups.values());
};

const HistoryList = ({
  history,
  selectedHistoryId,
  onSelect,
  onReveal,
  onRemove
}: HistoryListProps): React.JSX.Element => {
  if (history.length === 0) {
    return (
      <section aria-label="历史记录" className="history-list">
        <div className="empty-state history-list__empty">
          <span aria-hidden="true" className="empty-state__icon">
            <Icon name="history" size={24} />
          </span>
          <strong>还没有历史记录</strong>
          <p>任务结束后，最近结果、状态和输出目录会保留在这里。</p>
        </div>
      </section>
    );
  }

  const groups = groupHistory(history);

  return (
    <section aria-label={`历史记录，共 ${history.length} 项`} className="history-list">
      <motion.div
        animate="visible"
        aria-label="历史任务列表，按完成时间从新到旧排列"
        className="history-list__items"
        initial="hidden"
        role="list"
        variants={staggerContainerVariants}
      >
        <AnimatePresence initial={false}>
          {groups.map((group) => (
            <motion.section
              aria-label={`${group.label}，${group.items.length} 项`}
              className="history-list__group"
              key={group.key}
              layout
              role="group"
              variants={fadeUpVariants}
            >
              <header className="history-list__group-header">
                <h3>{group.label}</h3>
                <span>{group.items.length} 项</span>
              </header>

              <div className="history-list__group-items">
                {group.items.map((item) => {
                  const selected = selectedHistoryId === item.id;
                  const readableName = getReadableName(item);
                  const statusLabel = statusLabels[item.status];
                  const normalizedError = normalizeUiText(item.error);
                  const metaTags = [
                    item.sourceType === 'link' ? '链接' : '本地文件',
                    describeTaskLanguage(item),
                    typeof item.durationSeconds === 'number'
                      ? formatDuration(item.durationSeconds)
                      : undefined,
                    item.downloadBehavior && item.videoQuality
                      ? describeTaskMode({
                          downloadBehavior: item.downloadBehavior,
                          videoQuality: item.videoQuality
                        })
                      : undefined,
                    item.translateToChinese && item.downloadBehavior !== 'downloadOnly'
                      ? '含中文翻译'
                      : undefined
                  ].filter((value): value is string => Boolean(value));

                  return (
                    <motion.article
                      aria-label={`${readableName}，${statusLabel}`}
                      className={`history-card${selected ? ' is-selected' : ''}`}
                      exit="exit"
                      key={item.id}
                      layout
                      onClick={() => onSelect(item.id)}
                      role="listitem"
                      variants={fadeUpVariants}
                    >
                      <button
                        aria-label={`查看历史任务“${readableName}”，结果：${statusLabel}`}
                        aria-pressed={selected}
                        className="history-card__selection"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(item.id);
                        }}
                        title={`查看历史任务：${readableName}`}
                        type="button"
                      >
                        <span aria-hidden="true" className="history-card__source-icon">
                          <Icon name={item.sourceType === 'link' ? 'link' : 'file'} size={18} />
                        </span>
                        <span className="history-card__content">
                          <span className="history-card__title-row">
                            <strong title={readableName}>{truncate(readableName, 46)}</strong>
                            <span
                              aria-label={`结果状态：${statusLabel}`}
                              className={`status-badge ${statusTones[item.status]}`}
                              title={`任务结果：${statusLabel}`}
                            >
                              <span aria-hidden="true" className="status-badge__dot" />
                              {statusLabel}
                            </span>
                          </span>
                          <span className="history-card__info-row">
                            <span aria-label="任务信息" className="history-card__metadata" role="list">
                              {metaTags.map((value, index) => (
                                <span className="meta-tag" key={`${value}-${index}`} role="listitem" title={value}>
                                  {value}
                                </span>
                              ))}
                            </span>
                            <time dateTime={item.finishedAt} title={`完成于 ${item.finishedAt}`}>
                              {formatHistoryTime(item.finishedAt)}
                            </time>
                          </span>
                          {normalizedError ? (
                            <span className="history-card__error" title={normalizedError}>
                              <Icon aria-hidden="true" name="warning" size={15} />
                              {truncate(normalizedError, 120)}
                            </span>
                          ) : null}
                        </span>
                      </button>

                      <div aria-label="历史记录操作" className="history-card__actions" role="group">
                        <button
                          aria-label={
                            item.outputDir
                              ? `打开“${readableName}”的输出目录`
                              : `“${readableName}”没有可打开的输出目录`
                          }
                          className="history-card__action"
                          disabled={!item.outputDir}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (item.outputDir) {
                              onReveal(item.outputDir);
                            }
                          }}
                          title={item.outputDir ? `打开输出目录：${item.outputDir}` : '此任务没有输出目录'}
                          type="button"
                        >
                          <Icon aria-hidden="true" name="folder" size={16} />
                          <span>打开目录</span>
                        </button>
                        <button
                          aria-label={`移除历史记录“${readableName}”`}
                          className="history-card__action history-card__action--danger"
                          onClick={(event) => {
                            event.stopPropagation();
                            onRemove(item.id);
                          }}
                          title="移除此条历史记录，不会删除输出文件"
                          type="button"
                        >
                          <Icon aria-hidden="true" name="trash" size={16} />
                          <span>移除</span>
                        </button>
                      </div>
                    </motion.article>
                  );
                })}
              </div>
            </motion.section>
          ))}
        </AnimatePresence>
      </motion.div>
    </section>
  );
};

export default HistoryList;
