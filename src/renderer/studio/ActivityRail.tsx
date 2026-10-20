import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { HistoryRecord, TaskRecord, TaskStatus } from '../../shared/types';
import Icon from '../components/Icon';
import GlassSegmentedControl from '../glass/GlassSegmentedControl';
import GlassSelect from '../glass/GlassSelect';
import {GlassProgress} from '../glass/GlassProgress';
import type { WhisperWorkspaceController } from '../hooks/useWhisperWorkspace';
import { useContentTransition } from '../lens/useContentTransition';
import { describeTaskMode, formatDateTime, formatProgressPercent, getReadableName, isTaskActive, normalizeUiText, statusLabels, statusTones } from '../utils';
import TaskActions from './content/TaskActions';

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

function matchesQuery(record: TaskRecord | HistoryRecord, query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  return !term || `${getReadableName(record)} ${record.input ?? ''} ${record.outputDir ?? ''}`.toLocaleLowerCase().includes(term);
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

export function TaskProgress({ task, size='default' }: { task: TaskRecord; size?:'default'|'compact' }): React.JSX.Element {
  const completed=task.status==='completed';
  const known = completed || typeof task.progressPercent === 'number' && Number.isFinite(task.progressPercent);
  const percent = completed ? 100 : known ? Math.max(0, Math.min(100, task.progressPercent ?? 0)) : 0;
  const message = completed ? describeTaskMode(task) : normalizeUiText(task.progressMessage) || statusLabels[task.status];
  return <GlassProgress className="studio-task-progress" size={size} label="任务处理进度" value={known?percent:undefined} caption={message} displayValue={completed?undefined:known?formatProgressPercent(percent):statusLabels[task.status]} valueText={completed?'100% · 已完成':message} active={isTaskActive(task)}/>;
}

function ActivityRow({ record, task, selected, pinned, workspace, onSelect }: { record: TaskRecord | HistoryRecord; task?: TaskRecord; selected: boolean; pinned: boolean; workspace: WhisperWorkspaceController; onSelect: () => void }): React.JSX.Element {
  const name = getReadableName(record);
  const active = Boolean(task && isTaskActive(task));
  const timestamp = 'finishedAt' in record ? record.finishedAt : record.createdAt;
  const mode = record.downloadBehavior && record.videoQuality
    ? describeTaskMode({ downloadBehavior: record.downloadBehavior, videoQuality: record.videoQuality })
    : '媒体处理';
  return <li className={`lg-surface workbench-task-row${selected ? ' is-selected' : ''}${pinned ? ' is-pinned' : ''}${active ? ' is-active' : ''}`} data-glass="note" data-record-id={record.id}>
    <div className="workbench-task-row-main">
      <button className="workbench-task-select" data-lens-native-ignore type="button" onClick={onSelect} aria-pressed={selected} aria-label={`查看${task ? '任务' : '历史记录'}：${name}`}>
        <span className="workbench-task-name">
          <strong title={name}>{name}</strong>
          <span className="workbench-task-meta">
            <span className="workbench-task-source"><Icon name={record.sourceType === 'link' ? 'link' : 'file'} size={12} />{record.sourceType === 'link' ? '在线链接' : '本地文件'}</span>
            <time dateTime={timestamp}>{formatDateTime(timestamp)}</time>
            {record.translateToChinese ? <span className="workbench-task-translation">含译文</span> : null}
            {pinned ? <span className="workbench-task-viewing">当前查看</span> : null}
          </span>
        </span>
      </button>
      <TaskActions workspace={workspace} record={record} source={task ? 'queue' : 'history'} result={task} />
    </div>
    <div className="workbench-task-footer">
      <p className="workbench-task-description" title={mode}>{mode}</p>
      <span className={`studio-status is-${statusTones[record.status]}`}><span aria-hidden="true" />{statusLabels[record.status]}</span>
    </div>
    {task && active ? <div className="workbench-task-detail"><TaskProgress task={task} size="compact" /></div> : null}
    {record.error ? <p className="workbench-task-error" title={normalizeUiText(record.error)}>{normalizeUiText(record.error)}</p> : null}
  </li>;
}

/** Queue and history remain beside the importer and result; selection never navigates. */
export default function ActivityRail({ workspace, onSelectTask, onSelectHistory }: ActivityRailProps): React.JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sourcePositions = useRef({ queue: 0, history: 0 });
  const currentSource = useRef(workspace.activity.view);
  const [preferences, setPreferences] = useState(() => {
    const saved = readPreferences();
    return { ...saved, page: saved.source === workspace.activity.view ? saved.page : 1, source: workspace.activity.view };
  });
  const { query, filter } = preferences;
  const page = preferences.source === workspace.activity.view ? preferences.page : 1;
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
  const matches = useMemo(() => records.filter((record) => matchesFilter(record.status, filter) && matchesQuery(record, query)), [records, query, filter]);
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const paged = matches.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selectedId = history ? workspace.activity.selectedHistoryId : workspace.activity.selectedTaskId;
  const selectedRecord = records.find((record) => record.id === selectedId);
  // Keep a newly added or actively viewed item visible even with an older search/page.
  const pinned = selectedRecord && !paged.some((record) => record.id === selectedRecord.id) ? selectedRecord : undefined;
  const shown = pinned ? [pinned, ...paged] : paged;
  const { contentRef, displayedValue: content } = useContentTransition(
    { source: workspace.activity.view, history, shown, pinned, selectedId, query, filter, totalCount: records.length, matchCount: matches.length },
    JSON.stringify([workspace.activity.view, query.trim().toLocaleLowerCase(), filter, currentPage])
  );
  // A transition may retain a previous page or source, but must never retain a
  // deleted record or the old state of an action on a surviving record.
  const currentContentRecords: Array<TaskRecord | HistoryRecord> = content.history ? workspace.snapshot?.history ?? [] : workspace.snapshot?.tasks ?? [];
  const currentContentById = new Map(currentContentRecords.map((record) => [record.id, record]));
  const currentShown = content.shown.flatMap((record) => {
    const current = currentContentById.get(record.id);
    return current ? [current] : [];
  });
  const currentPinned = content.pinned ? currentContentById.get(content.pinned.id) : undefined;
  const currentMatchCount = currentContentRecords.filter((record) => matchesFilter(record.status, content.filter) && matchesQuery(record, content.query)).length;
  useLayoutEffect(() => {
    currentSource.current = content.source;
    if (scrollRef.current) scrollRef.current.scrollTop = sourcePositions.current[content.source];
  }, [content.source]);
  useEffect(() => { if (page > pageCount) setPreferences((current) => ({ ...current, page: pageCount })); }, [page, pageCount]);
  const resetFilters = (): void => setPreferences((current) => ({ ...current, query: '', filter: 'all', page: 1 }));

  return <section className="workbench-activity" ref={scrollRef} aria-labelledby="workbench-activity-title" onScroll={(event) => { sourcePositions.current[currentSource.current] = event.currentTarget.scrollTop; }}>
    <header className="workbench-activity-heading"><h2 id="workbench-activity-title">任务记录</h2><span>{workspace.activeTaskCount ? `${workspace.activeTaskCount} 项正在处理` : '可随时加入新任务'}</span></header>
    <div className="workbench-activity-source" role="group" aria-label="记录来源">
      <GlassSegmentedControl className="workbench-source-control" label="记录来源" value={history ? 'history' : 'queue'} onChange={(value) => setSource(value as 'queue' | 'history')} options={[{ value: 'queue', label: '当前任务', badge: workspace.snapshot?.tasks.length ?? 0 }, { value: 'history', label: '历史记录', badge: workspace.snapshot?.history.length ?? 0 }]} />
    </div>
    <div className="workbench-activity-filter">
      <div className="workbench-activity-search">
        <label><span className="studio-visually-hidden">搜索任务</span><svg className="workbench-search-icon" aria-hidden="true" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.25" /><path d="m12.5 12.5 4.25 4.25" /></svg><input ref={searchRef} type="search" placeholder="搜索任务" value={query} onChange={(event) => setPreferences((current) => ({ ...current, query: event.target.value, page: 1 }))} /></label>
        {query ? <button className="workbench-search-clear" data-lens-native-ignore type="button" aria-label="清除搜索" onClick={() => { setPreferences((current) => ({ ...current, query: '', page: 1 })); searchRef.current?.focus(); }}><Icon name="close" size={13} /></button> : null}
      </div>
      <label className="workbench-activity-status-filter"><span className="studio-visually-hidden">任务状态筛选</span><GlassSelect label="任务状态筛选" value={filter} onChange={(value) => setPreferences((current) => ({ ...current, filter: value as TaskFilter, page: 1 }))} options={filterOptions} /></label>
    </div>
    <div className="lens-content-transition workbench-activity-content" ref={contentRef}>
      <div className="workbench-activity-list-heading"><h3>{content.query || content.filter !== 'all' ? '筛选结果' : content.history ? '历史记录' : '当前任务'}</h3><span className="workbench-activity-list-count">{content.query || content.filter !== 'all' ? `${currentMatchCount} 项匹配` : `共 ${currentContentRecords.length} 项`}</span>{content.history && currentContentRecords.length > 0 ? <button className="workbench-history-clear" title="仅清空历史记录，保留当前任务和输出文件" type="button" onClick={workspace.requestClearHistory}>仅清空历史记录…</button> : null}</div>
      <div className="workbench-activity-pin-note" data-visible={Boolean(currentPinned)} aria-hidden={!currentPinned}>{currentPinned ? <><span>当前查看的任务固定显示</span>{content.query || content.filter !== 'all' ? <button type="button" onClick={resetFilters}>查看全部</button> : null}</> : null}</div>
      {currentShown.length ? <ul className="workbench-task-list" aria-label={`${content.history ? '历史记录' : '当前任务'}列表`}>
        {currentShown.map((record) => <ActivityRow key={record.id} record={record} task={content.history ? undefined : record as TaskRecord} selected={record.id === content.selectedId} pinned={record.id === currentPinned?.id} workspace={workspace} onSelect={() => content.history ? onSelectHistory(record.id) : onSelectTask(record.id)} />)}
      </ul> : <div className="workbench-activity-empty"><Icon name={content.history ? 'history' : 'queue'} size={23} /><p>{content.query || content.filter !== 'all' ? '没有符合条件的任务' : content.history ? '还没有历史记录' : '从上方添加媒体，任务会实时出现在这里。'}</p>{content.query || content.filter !== 'all' ? <button type="button" onClick={resetFilters}>清除筛选</button> : null}</div>}
    </div>
    {pageCount > 1 ? <nav className="workbench-activity-pages" aria-label="任务分页"><button type="button" disabled={currentPage === 1} onClick={() => setPreferences((current) => ({ ...current, page: currentPage - 1 }))}>上一页</button><span aria-live="polite">{currentPage} / {pageCount}</span><button type="button" disabled={currentPage === pageCount} onClick={() => setPreferences((current) => ({ ...current, page: currentPage + 1 }))}>下一页</button></nav> : null}
  </section>;
}
