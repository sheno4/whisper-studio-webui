import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';

import Icon from './components/Icon';
import { GlassButton, GlassSurface } from './glass';
import { useGlassCapability } from './glass/capabilities';
import { useLensRuntimeStage } from './lens/Runtime';
import { useContentTransition } from './lens/useContentTransition';
import { useAppearance } from './hooks/useAppearance';
import { useInteractionModality } from './hooks/useInteractionModality';
import { useWhisperWorkspace } from './hooks/useWhisperWorkspace';
import ActivityRail from './studio/ActivityRail';
import ImportSheet from './studio/ImportSheet';
import Preferences from './studio/Preferences';
import Reader from './studio/Reader';
import { Confirmation, Notifications, SystemPanel } from './studio/SystemPanel';
import { parseStudioRoute, routeHash } from './studio/navigation';

function App(): React.JSX.Element {
  const workspace = useWhisperWorkspace();
  const appearance = useAppearance();
  const glass = useGlassCapability();
  const stageRef = useRef<HTMLDivElement>(null);
  const readingScrollRef = useRef<HTMLDivElement>(null);
  const readingPositions = useRef(new Map<string, number>());
  const readingPositionKey = useRef('');
  useLensRuntimeStage(stageRef, { wallpaperUrl: workspace.wallpaperUrl });
  useInteractionModality();
  const [systemOpen, setSystemOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const consumingDrop = useRef(false);
  const dragDepth = useRef(0);
  const snapshot = workspace.snapshot;

  function focusImport(): void {
    const input = document.getElementById('studio-link-input') ?? document.querySelector<HTMLElement>('#workbench-import button:not(:disabled)');
    input?.focus();
    if (window.matchMedia('(max-width: 850px)').matches) document.getElementById('workbench-import')?.scrollIntoView({ block: 'start' });
  }

  function selectTask(id: string): void {
    workspace.setActivityView('queue');
    workspace.setSelectedTaskId(id);
    window.history.replaceState(null, '', routeHash({ kind: 'task', id }));
  }

  function selectHistory(id: string): void {
    workspace.setActivityView('history');
    workspace.setSelectedHistoryId(id);
    window.history.replaceState(null, '', routeHash({ kind: 'history', id }));
  }

  useEffect(() => {
    const selectFromLink = (): void => {
      const route = parseStudioRoute(window.location.hash);
      if (route.kind === 'task') { workspace.setActivityView('queue'); workspace.setSelectedTaskId(route.id); }
      else if (route.kind === 'history') { workspace.setActivityView('history'); workspace.setSelectedHistoryId(route.id); }
    };
    selectFromLink();
    window.addEventListener('hashchange', selectFromLink);
    return () => window.removeEventListener('hashchange', selectFromLink);
  }, [workspace.setActivityView, workspace.setSelectedTaskId, workspace.setSelectedHistoryId]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      const editable = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') { event.preventDefault(); focusImport(); }
      else if (event.key === '/' && !editable) { event.preventDefault(); document.querySelector<HTMLInputElement>('.workbench-activity input[type="search"]')?.focus(); }
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);

  function dragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); dragDepth.current += 1; workspace.setIsDragging(true);
  }
  function dragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) workspace.setIsDragging(false);
  }
  function drop(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); dragDepth.current = 0; workspace.setIsDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (workspace.composer.downloadBehavior === 'downloadOnly') { workspace.setDownloadBehavior('transcribe'); consumingDrop.current = false; setDroppedFiles(files); }
    else void workspace.addDroppedFiles(files);
  }
  useEffect(() => {
    if (!droppedFiles || consumingDrop.current || workspace.composer.downloadBehavior === 'downloadOnly') return;
    consumingDrop.current = true; setDroppedFiles(null); void workspace.addDroppedFiles(droppedFiles);
  }, [droppedFiles, workspace.composer.downloadBehavior, workspace.addDroppedFiles]);
  useEffect(() => {
    const clear = (): void => { dragDepth.current = 0; workspace.setIsDragging(false); };
    window.addEventListener('blur', clear); window.addEventListener('dragend', clear);
    return () => { window.removeEventListener('blur', clear); window.removeEventListener('dragend', clear); };
  }, [workspace.setIsDragging]);

  const record = workspace.activity.activeHistoryRecord ?? workspace.activity.activeTask;
  const recordKey = record ? `${workspace.activity.view}:${record.id}` : '';
  const readingContent = useContentTransition({ workspace, hasRecord: Boolean(record) }, recordKey);
  const retainedWorkspace = readingContent.displayedValue.workspace;
  const retainedRecord = retainedWorkspace.activity.activeHistoryRecord ?? retainedWorkspace.activity.activeTask;
  const retainedExists = retainedRecord && (retainedWorkspace.activity.view === 'history'
    ? snapshot?.history : snapshot?.tasks)?.some(item => item.id === retainedRecord.id);
  // A transition may retain a different selection, but never a deleted record
  // or the file actions and callbacks belonging to an obsolete snapshot.
  const presentedWorkspace = retainedExists ? { ...retainedWorkspace, snapshot } : workspace;
  const hasPresentedRecord = retainedExists ? readingContent.displayedValue.hasRecord : Boolean(record);
  const previousRecords = useRef(new Set<string>());
  const restoreDeletionFocus = useRef(false);
  useEffect(() => {
    if (snapshot) {
      const currentRecords = new Set([
        ...snapshot.tasks.map(item => `queue:${item.id}`),
        ...snapshot.history.map(item => `history:${item.id}`)
      ]);
      for (const key of previousRecords.current) {
        if (!currentRecords.has(key)) {
          restoreDeletionFocus.current = true;
          readingPositions.current.delete(key);
        }
      }
      previousRecords.current = currentRecords;
    }
    if (snapshot) {
      const route = routeHash(record
        ? { kind: workspace.activity.view === 'history' ? 'history' : 'task', id: record.id }
        : { kind: 'library' });
      if (window.location.hash !== route) window.history.replaceState(null, '', route);
    }
    if (restoreDeletionFocus.current && !workspace.confirmation) {
      restoreDeletionFocus.current = false;
      const rows = document.querySelectorAll<HTMLElement>('.workbench-task-row');
      const next = [...rows].find(row => row.dataset.recordId === record?.id)?.querySelector<HTMLButtonElement>('.workbench-task-select');
      const fallback = document.querySelector<HTMLElement>('.workbench-source-control button:not(:disabled)');
      (next ?? fallback)?.focus({ preventScroll: true });
    }
  }, [snapshot, recordKey, workspace.activity.view, workspace.confirmation]);
  useLayoutEffect(() => {
    // Restore only the result viewport. Selecting a record must never scroll
    // the document or rebuild the reader's stable controls.
    readingPositionKey.current = readingContent.displayedKey;
    if (readingScrollRef.current) readingScrollRef.current.scrollTop = readingPositions.current.get(readingContent.displayedKey) ?? 0;
  }, [readingContent.displayedKey]);
  const issues = snapshot?.environment.items.filter((item) => !item.ok).length ?? 0;
  const materialLabel = glass.enabled ? '玻璃' : '实色';

  function caption(title: string, id: string, detail: string): React.JSX.Element {
    return <header className="lens-pane-heading workbench-caption"><h2 id={id}>{title}</h2><span>{detail}</span></header>;
  }

  return <div ref={stageRef} className="studio-root lens-workspace studio-workbench-root" data-design-system="lens" onDragEnter={dragEnter} onDragLeave={dragLeave} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={drop} onDropCapture={(event) => { if (event.dataTransfer.types.includes('Files')) { dragDepth.current = 0; workspace.setIsDragging(false); } }}>
    <a className="studio-skip" href="#workbench-result" onClick={(event) => { event.preventDefault(); document.getElementById('workbench-result')?.focus(); }}>跳转到结果</a>
    <header className="lens-workspace-header studio-header workbench-header">
      <div className="studio-header-content">
        <a className="studio-brand" href="#workbench-import" onClick={(event) => { event.preventDefault(); focusImport(); }} aria-label="Whisper Studio，添加媒体"><span className="studio-brand-mark"><Icon name="waveform" size={24} /></span><span>Whisper <strong>Studio</strong></span></a>
        <div className="workbench-header-context"><span>工作台</span><small>{workspace.activeTaskCount ? `${workspace.activeTaskCount} 项正在处理` : '准备就绪'}</small></div>
        <div className="studio-header-actions">
          <GlassButton className="workbench-material-control" aria-label="切换界面材质" aria-pressed={glass.enabled} title={glass.enabled ? '切换为实色' : '启用透镜材质'} onClick={() => appearance.setMaterial(glass.enabled ? 'solid' : 'glass')}><Icon name="palette" size={17} /><span>{materialLabel}</span></GlassButton>
          <GlassButton className="workbench-status-control" aria-label="系统状态" onClick={() => setSystemOpen(true)} disabled={!snapshot}><span className={`studio-status-dot ${issues ? 'has-issue' : ''}`} /><span>系统状态</span>{issues ? <small>{issues}</small> : null}</GlassButton>
          <GlassButton className="studio-icon-button" aria-label="偏好设置" title="偏好设置" onClick={() => workspace.setSettingsOpen(true)} disabled={!snapshot}><Icon name="settings" /></GlassButton>
        </div>
      </div>
    </header>

    <main className="lens-workspace-main studio-content workbench-main" aria-label="工作台">
      <h1 className="studio-visually-hidden">Whisper Studio 工作台</h1>
      {!snapshot ? <GlassSurface className="studio-startup" as="section" aria-live="polite"><Icon name={workspace.loadError ? 'warning' : 'waveform'} size={40} /><h2>{workspace.loadError ? '暂时无法连接工作台' : '正在连接工作台'}</h2><p>{workspace.loadError || '正在读取任务与运行环境。'}</p>{workspace.loadError ? <GlassButton onClick={() => void workspace.reload()}>重新连接</GlassButton> : null}</GlassSurface> : <div className="lens-workspace-grid workbench-grid">
        <GlassSurface className="lens-pane workbench-pane workbench-input-pane" as="section" id="workbench-import" aria-labelledby="workbench-import-heading">
          {caption('导入媒体', 'workbench-import-heading', '01')}
          <ImportSheet workspace={workspace} variant="inline" />
        </GlassSurface>
        <GlassSurface className="lens-pane workbench-pane workbench-activity-pane" as="section" aria-labelledby="workbench-activity-heading">
          {caption('任务记录', 'workbench-activity-heading', '02')}
          <ActivityRail workspace={workspace} onSelectTask={selectTask} onSelectHistory={selectHistory} />
        </GlassSurface>
        <GlassSurface className="lens-pane workbench-pane workbench-result-pane" as="section" id="workbench-result" aria-labelledby="workbench-result-heading" tabIndex={-1}>
          {caption('文字与文件', 'workbench-result-heading', '03')}
          <div className="workbench-reading-scroll" ref={readingScrollRef} onScroll={(event) => { if (readingPositionKey.current) readingPositions.current.set(readingPositionKey.current, event.currentTarget.scrollTop); }}><div className="lens-content-transition workbench-reading-content" ref={readingContent.contentRef}>{hasPresentedRecord ? <Reader workspace={presentedWorkspace} embedded /> : <div className="workbench-empty"><Icon name="waveform" size={38} /><h3>让声音变成文字</h3><p>从左侧添加媒体，或选择一个任务。<br />转写、译文、字幕与日志会显示在这里。</p><GlassButton onClick={focusImport}><Icon name="upload" size={17} />添加媒体</GlassButton></div>}</div></div>
        </GlassSurface>
      </div>}
    </main>
    <footer className="studio-footer workbench-footer"><span>媒体与结果保存在本机</span><span><kbd>Alt</kbd> + <kbd>N</kbd> 添加媒体<span className="workbench-footer-separator">·</span><kbd>/</kbd> 搜索任务</span></footer>
    <nav className="workbench-mobile-jumps" aria-label="工作台定位"><a href="#workbench-import" onClick={(event) => { event.preventDefault(); focusImport(); }}>导入</a><a href="#workbench-activity-heading">任务</a><a href="#workbench-result" onClick={(event) => { event.preventDefault(); document.getElementById('workbench-result')?.scrollIntoView({ block: 'start' }); }}>结果</a></nav>
    {snapshot ? <Preferences open={workspace.settingsOpen} workspace={workspace} appearance={appearance} onClose={() => workspace.setSettingsOpen(false)} /> : null}
    {systemOpen && snapshot ? <SystemPanel workspace={workspace} onClose={() => setSystemOpen(false)} onPreferences={() => { setSystemOpen(false); workspace.setSettingsOpen(true); }} /> : null}
    {workspace.confirmation ? <Confirmation workspace={workspace} /> : null}
    {workspace.isDragging ? <div className="studio-drop" aria-live="polite"><GlassSurface className="studio-drop-card"><Icon name="upload" size={38} /><h2>松开，添加媒体</h2><p>使用当前的语言与翻译选项。</p></GlassSurface></div> : null}
    <Notifications toasts={workspace.toasts} />
  </div>;
}

export default App;
