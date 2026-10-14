import { useEffect, useMemo, useRef, useState } from 'react';

import type { HistoryRecord, TaskRecord, TaskStatus } from '../../shared/types';
import Icon from '../components/Icon';
import GlassSegmentedControl from '../glass/GlassSegmentedControl';
import { useScrollEdge } from '../glass/useScrollEdge';
import type { WhisperWorkspaceController } from '../hooks/useWhisperWorkspace';
import { describeTaskMode, formatDateTime, formatProgressPercent, getReadableName, isTaskActive, normalizeUiText, statusLabels, statusTones } from '../utils';
import ActionMenu from './content/ActionMenu';
import './activity-rail.css';

export interface ActivityRailProps {
  workspace: WhisperWorkspaceController;
  onSelectTask: (id: string) => void;
  onSelectHistory: (id: string) => void;
}

type TaskFilter = 'all' | 'active' | 'ready' | 'attention';
interface RailPreferences { query: string; filter: TaskFilter; page: number; source: 'queue' | 'history' }
const pageSize = 36;
const activeStatuses = new Set<TaskStatus>(['queued', 'downloading', 'preprocessing', 'transcribing', 'translating']);
const retryableStatuses = new Set<TaskStatus>(['failed', 'cancelled', 'partial']);
const filterOptions: Array<{ value: TaskFilter; label: string }> = [
  { value: 'all', label: '全部状态' }, { value: 'active', label: '进行中' },
  { value: 'ready', label: '已完成' }, { value: 'attention', label: '需处理' }
];

function matchesFilter(status: TaskStatus, filter: TaskFilter): boolean {
  if (filter === 'active') return activeStatuses.has(status);
  if (filter === 'ready') return status === 'completed' || status === 'partial';
  if (filter === 'attention') return retryableStatuses.has(status);
  return true;
}

function readPreferences(): RailPreferences {
  try {
    const saved = JSON.parse(sessionStorage.getItem('whisper-studio.workbench.tasks') ?? '{}');
    return {
      query: typeof saved.query === 'string' ? saved.query : '',
      filter: filterOptions.some((option) => option.value === saved.filter) ? saved.filter : 'all',
      page: Number.isSafeInteger(saved.page) && saved.page > 0 ? saved.page : 1,
      source: saved.source === 'history' ? 'history' : 'queue'
    };
  } catch { return { query: '', filter: 'all', page: 1, source: 'queue' }; }
}

export function TaskProgress({ task }: { task: TaskRecord }): React.JSX.Element {
  const known = typeof task.progressPercent === 'number' && Number.isFinite(task.progressPercent);
  const percent = known ? Math.max(0, Math.min(100, task.progressPercent ?? 0)) : 0;
  const message = normalizeUiText(task.progressMessage) || statusLabels[task.status];
  return <div className="studio-task-progress">
    <div className="studio-progress-caption"><span>{message}</span><strong>{known ? formatProgressPercent(percent) : statusLabels[task.status]}</strong></div>
    <div aria-label="任务处理进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? percent : undefined} aria-valuetext={message} className={`studio-progress-track${!known && isTaskActive(task) ? ' is-pending' : ''}`} role="progressbar">
      <span aria-hidden="true" style={{ transform: `scaleX(${percent / 100})` }} />
    </div>
  </div>;
}

function ActivityRow({ record, task, selected, pinned, workspace, onSelect }: { record: TaskRecord | HistoryRecord; task?: TaskRecord; selected: boolean; pinned: boolean; workspace: WhisperWorkspaceController; onSelect: () => void }): React.JSX.Element {
  const name = getReadableName(record);
  const active = Boolean(task && isTaskActive(task));
  return <li className={`workbench-task-row${selected ? ' is-selected' : ''}${pinned ? ' is-pinned' : ''}`} data-record-id={record.id}>
    <div className="workbench-task-row-main">
      <button className="workbench-task-select" type="button" onClick={onSelect} aria-pressed={selected} aria-label={`查看${task ? '任务' : '历史记录'}：${name}`}>
        <span className="workbench-task-symbol" aria-hidden="true"><Icon name={record.sourceType === 'link' ? 'link' : 'file'} size={18} /></span>
        <span className="workbench-task-name"><strong title={name}>{name}</strong><small>{pinned ? '当前查看 · ' : ''}{formatDateTime('finishedAt' in record ? record.finishedAt : record.createdAt)}{task?.translateToChinese ? ' · 含译文' : ''}</small></span>
        <span className={`studio-status is-${statusTones[record.status]}`}><span aria-hidden="true" />{statusLabels[record.status]}</span>
      </button>
      <ActionMenu className="workbench-task-menu" ariaLabel={`${name}的操作`} label={<span aria-hidden="true">···</span>}>
        <button onClick={onSelect} type="button" role="menuitem">查看内容</button>
        {task && retryableStatuses.has(task.status) ? <button onClick={() => void workspace.retryTask(task.id)} type="button" role="menuitem"><Icon name="retry" />重新执行</button> : null}
        {task && active ? <button onClick={() => void workspace.cancelTask(task.id)} type="button" role="menuitem"><Icon name="stop" />取消任务</button> : null}
        <button disabled={!record.outputDir} onClick={() => { if (record.outputDir) void workspace.revealPath(record.outputDir); }} type="button" role="menuitem"><Icon name="folder" />打开输出目录</button>
        {task ? <button onClick={() => void workspace.openSourceLocation(task.id)} type="button" role="menuitem"><Icon name="external" />定位媒体文件</button> : null}
        {!active ? <button onClick={() => void (task ? workspace.removeTask(record.id) : workspace.removeHistory(record.id))} type="button" role="menuitem"><Icon name="close" />{task ? '移出当前任务' : '移除历史记录'}</button> : null}
      </ActionMenu>
    </div>
    {task && active ? <TaskProgress task={task} /> : task ? <p className="workbench-task-description">{describeTaskMode(task)}</p> : null}
    {record.error ? <p className="workbench-task-error">{normalizeUiText(record.error)}</p> : null}
  </li>;
}

/** Queue and history remain beside the importer and result; selection never navigates. */
export default function ActivityRail({ workspace, onSelectTask, onSelectHistory }: ActivityRailProps): React.JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  useScrollEdge(scrollRef, { barSelector: '.workbench-activity-source' });
  const [preferences, setPreferences] = useState(() => {
    const saved = readPreferences();
    return { ...saved, page: saved.source === workspace.activity.view ? saved.page : 1, source: workspace.activity.view };
  });
  const { query, filter, page } = preferences;
  const history = workspace.activity.view === 'history';
  useEffect(() => { try { sessionStorage.setItem('whisper-studio.workbench.tasks', JSON.stringify(preferences)); } catch { /* Optional UI state. */ } }, [preferences]);
  useEffect(() => {
    if (preferences.source !== workspace.activity.view) setPreferences((current) => ({ ...current, source: workspace.activity.view, page: 1 }));
  }, [preferences.source, workspace.activity.view]);
  const setSource = (source: 'queue' | 'history'): void => {
    workspace.setActivityView(source);
    setPreferences((current) => ({ ...current, source, page: current.source === source ? current.page : 1 }));
  };
  const records = useMemo<Array<TaskRecord | HistoryRecord>>(() => {
    const source = history ? workspace.snapshot?.history ?? [] : workspace.snapshot?.tasks ?? [];
    return [...source].sort((a, b) => Date.parse('finishedAt' in b ? b.finishedAt : b.createdAt) - Date.parse('finishedAt' in a ? a.finishedAt : a.createdAt));
  }, [history, workspace.snapshot?.history, workspace.snapshot?.tasks]);
  const matches = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return records.filter((record) => matchesFilter(record.status, filter) && (!term || `${getReadableName(record)} ${'input' in record ? record.input : ''} ${record.outputDir ?? ''}`.toLocaleLowerCase().includes(term)));
  }, [records, query, filter]);
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const paged = matches.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selectedId = history ? workspace.activity.selectedHistoryId : workspace.activity.selectedTaskId;
  const selectedRecord = records.find((record) => record.id === selectedId);
  // Keep a newly added or actively viewed item visible even with an older search/page.
  const pinned = selectedRecord && !paged.some((record) => record.id === selectedRecord.id) ? selectedRecord : undefined;
  const shown = pinned ? [pinned, ...paged] : paged;
  useEffect(() => { if (page > pageCount) setPreferences((current) => ({ ...current, page: pageCount })); }, [page, pageCount]);
  const resetFilters = (): void => setPreferences((current) => ({ ...current, query: '', filter: 'all', page: 1 }));

  return <section className="workbench-activity" ref={scrollRef} aria-labelledby="workbench-activity-title">
    <header className="workbench-activity-heading"><h2 id="workbench-activity-title">任务</h2><span>{workspace.activeTaskCount ? `${workspace.activeTaskCount} 项正在处理` : '可随时加入新任务'}</span></header>
    <div className="workbench-activity-source" role="group" aria-label="记录来源">
      <GlassSegmentedControl className="workbench-source-control" label="记录来源" value={history ? 'history' : 'queue'} onChange={(value) => setSource(value as 'queue' | 'history')} options={[{ value: 'queue', label: '当前任务', badge: workspace.snapshot?.tasks.length ?? 0 }, { value: 'history', label: '历史记录', badge: workspace.snapshot?.history.length ?? 0 }]} />
      {history && records.length ? <button className="workbench-history-clear" aria-label="清空历史记录" type="button" onClick={workspace.requestClearHistory}><Icon name="trash" size={16} /></button> : null}
    </div>
    <div className="workbench-activity-filter">
      <label><span className="studio-visually-hidden">搜索任务</span><input type="search" placeholder="搜索任务" value={query} onChange={(event) => setPreferences((current) => ({ ...current, query: event.target.value, page: 1 }))} /></label>
      <label><span className="studio-visually-hidden">任务状态筛选</span><select value={filter} onChange={(event) => setPreferences((current) => ({ ...current, filter: event.target.value as TaskFilter, page: 1 }))}>{filterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    </div>
    {pinned ? <div className="workbench-activity-pin-note"><span>当前查看的任务固定显示</span>{query || filter !== 'all' ? <button type="button" onClick={resetFilters}>查看全部</button> : null}</div> : null}
    {shown.length ? <ul className="workbench-task-list" aria-label={`${history ? '历史记录' : '当前任务'}列表`}>
      {shown.map((record) => <ActivityRow key={record.id} record={record} task={history ? undefined : record as TaskRecord} selected={record.id === selectedId} pinned={record.id === pinned?.id} workspace={workspace} onSelect={() => history ? onSelectHistory(record.id) : onSelectTask(record.id)} />)}
    </ul> : <div className="workbench-activity-empty"><Icon name={history ? 'history' : 'queue'} size={23} /><p>{query || filter !== 'all' ? '没有符合条件的任务' : history ? '还没有历史记录' : '从上方添加媒体，任务会实时出现在这里。'}</p>{query || filter !== 'all' ? <button type="button" onClick={resetFilters}>清除筛选</button> : null}</div>}
    {pageCount > 1 ? <nav className="workbench-activity-pages" aria-label="任务分页"><button type="button" disabled={currentPage === 1} onClick={() => setPreferences((current) => ({ ...current, page: currentPage - 1 }))}>上一页</button><span aria-live="polite">{currentPage} / {pageCount}</span><button type="button" disabled={currentPage === pageCount} onClick={() => setPreferences((current) => ({ ...current, page: currentPage + 1 }))}>下一页</button></nav> : null}
  </section>;
}
