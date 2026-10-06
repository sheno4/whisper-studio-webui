import { AnimatePresence, motion } from 'framer-motion';

import type { HistoryRecord, TaskRecord } from '../../shared/types';
import type { ActivityView } from '../hooks/useWhisperWorkspace';
import { paneSwitchVariants } from '../motion';
import HistoryList from './HistoryList';
import Icon from './Icon';
import SegmentedControl from './SegmentedControl';
import TaskQueue from './TaskQueue';

interface ActivityPanelProps {
  view: ActivityView;
  tasks: TaskRecord[];
  history: HistoryRecord[];
  selectedTaskId?: string;
  selectedHistoryId?: string;
  onChangeView: (view: ActivityView) => void;
  onSelectTask: (taskId: string) => void;
  onSelectHistory: (historyId: string) => void;
  onRetryTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onRemoveTask: (taskId: string) => void;
  onRevealHistory: (targetPath: string) => void;
  onRemoveHistory: (historyId: string) => void;
  onClearHistory: () => void;
}

function ActivityPanel({
  view,
  tasks,
  history,
  selectedTaskId,
  selectedHistoryId,
  onChangeView,
  onSelectTask,
  onSelectHistory,
  onRetryTask,
  onCancelTask,
  onRemoveTask,
  onRevealHistory,
  onRemoveHistory,
  onClearHistory
}: ActivityPanelProps): React.JSX.Element {
  const showingQueue = view === 'queue';

  return (
    <section className="activity-shell glass-panel">
      <header className="panel-header activity-header">
        <div className="panel-heading">
          <span className="panel-icon" aria-hidden="true">
            <Icon name={showingQueue ? 'queue' : 'history'} size={17} />
          </span>
          <div>
            <p className="eyebrow">任务中心</p>
            <h2>{showingQueue ? '当前队列' : '历史记录'}</h2>
          </div>
        </div>

        <div className="activity-toolbar">
          {!showingQueue && history.length > 0 ? (
            <button className="text-action danger" onClick={onClearHistory} type="button">
              清空
            </button>
          ) : null}
          <SegmentedControl
            ariaLabel="任务视图"
            className="activity-tabs"
            id="activity-tabs"
            items={[
              { value: 'queue', label: '队列', badge: tasks.length },
              { value: 'history', label: '历史', badge: history.length }
            ]}
            onChange={onChangeView}
            value={view}
          />
        </div>
      </header>

      <div className="activity-content">
        <AnimatePresence initial={false} mode="wait">
          {showingQueue ? (
            <motion.div
              animate="active"
              className="activity-pane"
              exit="inactive"
              initial="inactive"
              key="queue"
              variants={paneSwitchVariants}
            >
              <TaskQueue
                onCancel={onCancelTask}
                onRemove={onRemoveTask}
                onRetry={onRetryTask}
                onSelect={onSelectTask}
                selectedTaskId={selectedTaskId}
                tasks={tasks}
              />
            </motion.div>
          ) : (
            <motion.div
              animate="active"
              className="activity-pane"
              exit="inactive"
              initial="inactive"
              key="history"
              variants={paneSwitchVariants}
            >
              <HistoryList
                history={history}
                onRemove={onRemoveHistory}
                onReveal={onRevealHistory}
                onSelect={onSelectHistory}
                selectedHistoryId={selectedHistoryId}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

export default ActivityPanel;
