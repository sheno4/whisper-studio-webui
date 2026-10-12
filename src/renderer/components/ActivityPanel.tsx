import type { HistoryRecord, TaskRecord } from '../../shared/types';
import type { ActivityView } from '../hooks/useWhisperWorkspace';
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
    <section aria-labelledby="activity-panel-title" className="activity-shell content-panel">
      <header className="panel-header activity-header">
        <div className="panel-heading">
          <span className="panel-icon" aria-hidden="true">
            <Icon name={showingQueue ? 'queue' : 'history'} size={17} />
          </span>
          <div>
            <h2 id="activity-panel-title">任务中心</h2>
          </div>
        </div>

        <div className="activity-toolbar control-rail">
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
          {showingQueue ? (
            <div
              className="activity-pane"
              key="queue"
            >
              <TaskQueue
                onCancel={onCancelTask}
                onRemove={onRemoveTask}
                onRetry={onRetryTask}
                onSelect={onSelectTask}
                selectedTaskId={selectedTaskId}
                tasks={tasks}
              />
            </div>
          ) : (
            <div
              className="activity-pane"
              key="history"
            >
              <HistoryList
                history={history}
                onRemove={onRemoveHistory}
                onReveal={onRevealHistory}
                onSelect={onSelectHistory}
                selectedHistoryId={selectedHistoryId}
              />
            </div>
          )}
      </div>
    </section>
  );
}

export default ActivityPanel;
