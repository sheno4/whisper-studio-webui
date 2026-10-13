import { useEffect, useMemo, useState } from 'react';

import type { HistoryRecord, TaskRecord, TaskStatus } from '../../shared/types';
import Icon from '../components/Icon';
import { GlassButton, GlassSurface } from '../glass';
import type { WhisperWorkspaceController } from '../hooks/useWhisperWorkspace';
import { describeTaskMode, formatDateTime, formatProgressPercent, getReadableName, isTaskActive, normalizeUiText, statusLabels, statusTones } from '../utils';
import ActionMenu from './content/ActionMenu';

export interface LibraryProps {
  workspace: WhisperWorkspaceController;
  onOpenTask: (id: string) => void;
  onOpenHistory: (id: string) => void;
  onNew: () => void;
}

type LibraryFilter = 'all' | 'active' | 'ready' | 'attention';
const pageSize = 36;
interface LibraryPreferences { query: string; filter: LibraryFilter; layout: 'grid' | 'list'; page: number; source: 'queue' | 'history' }
const activeStatuses = new Set<TaskStatus>(['queued', 'downloading', 'preprocessing', 'transcribing', 'translating']);
const retryableStatuses = new Set<TaskStatus>(['failed', 'cancelled', 'partial']);
const filterOptions: Array<{ value: LibraryFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'ready', label: '已完成' },
  { value: 'attention', label: '需处理' }
];

function matchesFilter(status: TaskStatus, filter: LibraryFilter): boolean {
  if (filter === 'active') return activeStatuses.has(status);
  if (filter === 'ready') return status === 'completed' || status === 'partial';
  if (filter === 'attention') return status === 'failed' || status === 'cancelled' || status === 'partial';
  return true;
}

function readPreferences(): LibraryPreferences {
  try {
    const saved = JSON.parse(sessionStorage.getItem('whisper-studio.library') ?? '{}');
    return {
      query: typeof saved.query === 'string' ? saved.query : '',
      filter: filterOptions.some((option) => option.value === saved.filter) ? saved.filter : 'all',
      layout: saved.layout === 'list' ? 'list' : 'grid',
      page: Number.isSafeInteger(saved.page) && saved.page > 0 ? saved.page : 1,
      source: saved.source === 'history' ? 'history' : 'queue'
    };
  } catch { return { query: '', filter: 'all', layout: 'grid', page: 1, source: 'queue' }; }
}

export function TaskProgress({ task }: { task: TaskRecord }): React.JSX.Element {
  const known = typeof task.progressPercent === 'number' && Number.isFinite(task.progressPercent);
  const percent = known ? Math.max(0, Math.min(100, task.progressPercent ?? 0)) : 0;
  const message = normalizeUiText(task.progressMessage) || statusLabels[task.status];
  return (
    <div className="studio-task-progress">
      <div className="studio-progress-caption"><span>{message}</span><strong>{known ? formatProgressPercent(percent) : statusLabels[task.status]}</strong></div>
      <div aria-label="任务处理进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? percent : undefined} aria-valuetext={message} className={`studio-progress-track${!known && isTaskActive(task) ? ' is-pending' : ''}`} role="progressbar">
        <span aria-hidden="true" style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
    </div>
  );
}

function RecordCard({ record, task, workspace, onOpen }: { record: TaskRecord | HistoryRecord; task?: TaskRecord; workspace: WhisperWorkspaceController; onOpen: () => void }): React.JSX.Element {
  const active = Boolean(task && isTaskActive(task));
  const name = getReadableName(record);
  const history = !task;
  return (
    <li className={`studio-library-item is-${record.status}`}>
      <article className="studio-media-card">
        <button className="studio-media-open" onClick={onOpen} type="button" aria-label={`打开${history ? '历史记录' : '任务'}：${name}`}>
          <span className="studio-media-symbol" aria-hidden="true"><Icon name={record.sourceType === 'link' ? 'link' : 'file'} size={29} /></span>
          <span className={`studio-status is-${statusTones[record.status]}`}><span aria-hidden="true" />{statusLabels[record.status]}</span>
          <strong className="studio-media-name" title={name}>{name}</strong>
          <span className="studio-media-meta">{record.sourceType === 'link' ? '在线媒体' : '本地文件'}<span aria-hidden="true"> · </span>{formatDateTime(history ? (record as HistoryRecord).finishedAt : record.createdAt)}</span>
          <span className="studio-media-description">{task ? describeTaskMode(task) : '已归档的任务摘要'}</span>
        </button>
        {task && active ? <TaskProgress task={task} /> : null}
        {record.error ? <p className="studio-card-error">{normalizeUiText(record.error)}</p> : null}
        <footer className="studio-media-actions">
          <span>{task?.translateToChinese ? '含中文译文' : history ? '历史记录' : '任务'}</span>
          <ActionMenu ariaLabel={`${name}的操作`} label={<>更多<span aria-hidden="true"> ···</span></>}>
            <button onClick={onOpen} type="button" role="menuitem">查看详情</button>
            {task && retryableStatuses.has(task.status) ? <button onClick={() => void workspace.retryTask(task.id)} type="button" role="menuitem"><Icon name="retry" />重新执行</button> : null}
            {task && active ? <button onClick={() => void workspace.cancelTask(task.id)} type="button" role="menuitem"><Icon name="stop" />取消任务</button> : null}
            <button disabled={!record.outputDir} onClick={() => { if (record.outputDir) void workspace.revealPath(record.outputDir); }} type="button" role="menuitem"><Icon name="folder" />打开输出目录</button>
            {!active ? <button onClick={() => void (history ? workspace.removeHistory(record.id) : workspace.removeTask(record.id))} type="button" role="menuitem"><Icon name="close" />{history ? '移除历史记录' : '移出当前任务'}</button> : null}
          </ActionMenu>
        </footer>
      </article>
    </li>
  );
}

export default function Library({ workspace, onOpenTask, onOpenHistory, onNew }: LibraryProps): React.JSX.Element {
  const [preferences, setPreferences] = useState(() => {
    const saved = readPreferences();
    return { ...saved, page: saved.source === workspace.activity.view ? saved.page : 1, source: workspace.activity.view };
  });
  const { query, filter, layout, page } = preferences;
  const setQuery = (value: string): void => setPreferences((current) => ({ ...current, query: value, page: 1 }));
  const setFilter = (value: LibraryFilter): void => setPreferences((current) => ({ ...current, filter: value, page: 1 }));
  const setLayout = (value: 'grid' | 'list'): void => setPreferences((current) => ({ ...current, layout: value }));
  useEffect(() => { try { sessionStorage.setItem('whisper-studio.library', JSON.stringify(preferences)); } catch { /* Optional presentation preference. */ } }, [preferences]);
  const history = workspace.activity.view === 'history';
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
  const visibleRecords = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return records.filter((record) => matchesFilter(record.status, filter) && (!term || `${getReadableName(record)} ${'input' in record ? record.input : ''} ${record.outputDir ?? ''}`.toLocaleLowerCase().includes(term)));
  }, [records, filter, query]);
  const pageCount = Math.max(1, Math.ceil(visibleRecords.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedRecords = visibleRecords.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => { if (page > pageCount) setPreferences((current) => ({ ...current, page: pageCount })); }, [page, pageCount]);
  return (
    <section className="studio-library" aria-labelledby="studio-library-title">
      <header className="studio-library-heading">
        <div><p className="studio-eyebrow">你的媒体工作室</p><h1 id="studio-library-title">资料库</h1><p>{workspace.activeTaskCount ? `${workspace.activeTaskCount} 个任务正在处理，你可以继续添加媒体。` : '把声音变成文字，保存每一个值得留下的想法。'}</p></div>
        <GlassButton className="studio-primary studio-create" onClick={onNew}><span aria-hidden="true">＋</span>新建任务</GlassButton>
      </header>

      <GlassSurface className="studio-library-tools" as="nav" radius={26} aria-label="资料库工具">
        <div className="studio-source-switch" role="group" aria-label="记录来源">
          <button aria-pressed={!history} className={!history ? 'is-selected' : ''} onClick={() => setSource('queue')} type="button">当前任务<span>{workspace.snapshot?.tasks.length ?? 0}</span></button>
          <button aria-pressed={history} className={history ? 'is-selected' : ''} onClick={() => setSource('history')} type="button">历史记录<span>{workspace.snapshot?.history.length ?? 0}</span></button>
        </div>
        <label className="studio-search"><span className="studio-visually-hidden">搜索任务</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或来源" /></label>
        <div className="studio-layout-switch" role="group" aria-label="排列方式">
          <button type="button" className={layout === 'grid' ? 'is-selected' : ''} aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}>网格</button>
          <button type="button" className={layout === 'list' ? 'is-selected' : ''} aria-pressed={layout === 'list'} onClick={() => setLayout('list')}>列表</button>
        </div>
      </GlassSurface>
      <div className="studio-library-filter-row">
        <div className="studio-filter-options" role="group" aria-label="任务状态筛选">
          {filterOptions.map((option) => <button aria-pressed={filter === option.value} className={filter === option.value ? 'is-selected' : ''} key={option.value} onClick={() => setFilter(option.value)} type="button">{option.label}<span>{records.filter((record) => matchesFilter(record.status, option.value)).length}</span></button>)}
        </div>
        {history && records.length > 0 ? <button className="studio-text-button" onClick={workspace.requestClearHistory} type="button">清空历史</button> : null}
      </div>

      {visibleRecords.length ? <>
      <ul className={`studio-library-collection is-${layout}`} aria-label={`${history ? '历史记录' : '当前任务'}，共 ${visibleRecords.length} 项，第 ${currentPage} 页`}>
        {pagedRecords.map((record) => <RecordCard key={record.id} record={record} task={history ? undefined : record as TaskRecord} workspace={workspace} onOpen={() => history ? onOpenHistory(record.id) : onOpenTask(record.id)} />)}
      </ul>
      {pageCount > 1 ? <nav className="studio-library-pages" aria-label="资料库分页">
        <p>显示 {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, visibleRecords.length)} 项，共 {visibleRecords.length} 项</p>
        <div><button className="studio-button" type="button" disabled={currentPage === 1} onClick={() => setPreferences((current) => ({ ...current, page: currentPage - 1 }))}>上一页</button><span aria-live="polite">第 {currentPage} / {pageCount} 页</span><button className="studio-button" type="button" disabled={currentPage === pageCount} onClick={() => setPreferences((current) => ({ ...current, page: currentPage + 1 }))}>下一页</button></div>
      </nav> : null}
      </> : <div className="studio-library-empty">
        <span className="studio-empty-symbol" aria-hidden="true"><Icon name={query || filter !== 'all' ? 'queue' : 'waveform'} size={42} /></span>
        <h2>{query || filter !== 'all' ? '没有符合条件的任务' : history ? '还没有历史记录' : '从一段声音开始'}</h2>
        <p>{query || filter !== 'all' ? '试试其他关键词，或查看全部任务。' : history ? '处理结束的任务会保留在这里。' : '粘贴媒体链接、选择本地文件，或将文件拖到窗口中。'}</p>
        {query || filter !== 'all' ? <GlassButton onClick={() => { setQuery(''); setFilter('all'); }}>重置筛选</GlassButton> : !history ? <GlassButton className="studio-primary" onClick={onNew}>添加第一项媒体</GlassButton> : null}
      </div>}
    </section>
  );
}
