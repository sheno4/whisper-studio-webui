import { useEffect, useRef, useState, type DragEvent } from 'react';

import Icon from './components/Icon';
import { GlassButton, GlassSurface } from './glass';
import { useGlassCapability } from './glass/capabilities';
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
  const issues = snapshot?.environment.items.filter((item) => !item.ok).length ?? 0;
  const materialLabel = appearance.material === 'solid' ? '实色' : glass.mode === 'optical' ? '液态玻璃' : '玻璃暂不可用';

  function caption(title: string, id: string, detail: string): React.JSX.Element {
    return <div className="workbench-caption" data-glass-drag-handle title="按住拖动，松手弹回原位">
      <span className="workbench-grip" aria-hidden="true"><span /><span /></span>
      <h2 id={id}>{title}</h2><span className="workbench-caption-detail">{detail}</span>
      <span className="workbench-drag-hint" aria-hidden="true">拖动试试</span>
    </div>;
  }

  return <div className="studio-root studio-workbench-root" onDragEnter={dragEnter} onDragLeave={dragLeave} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={drop} onDropCapture={(event) => { if (event.dataTransfer.types.includes('Files')) { dragDepth.current = 0; workspace.setIsDragging(false); } }}>
    <a className="studio-skip" href="#workbench-result" onClick={(event) => { event.preventDefault(); document.getElementById('workbench-result')?.focus(); }}>跳转到结果</a>
    <div className="studio-landscape workbench-landscape" aria-hidden="true">
      <svg className="workbench-contours" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"><path d="M-160 180C220-140 510 630 850 440S1420 0 1770 360" /><path d="M-160 212C220-108 510 662 850 472S1420 32 1770 392" /><path d="M-160 244C220-76 510 694 850 504S1420 64 1770 424" /><path d="M-160 650C300 280 650 1090 970 760S1460 460 1810 850" /></svg>
      {workspace.wallpaperUrl ? <div className="studio-wallpaper" style={{ backgroundImage: `url(${JSON.stringify(workspace.wallpaperUrl)})` }} /> : null}
    </div>
    <GlassSurface as="header" className="studio-header workbench-header" radius={26} refractionHeight={14} refractionAmount={26}>
      <div className="studio-header-content">
        <div className="studio-brand"><span className="studio-brand-mark"><Icon name="waveform" size={24} /></span><span>Whisper <strong>Studio</strong></span></div>
        <div className="workbench-header-context"><span>工作台</span><small>{workspace.activeTaskCount ? `${workspace.activeTaskCount} 个任务处理中` : '随时开始'}</small></div>
        <div className="studio-header-actions">
          <GlassButton className="workbench-material-control" aria-label="切换界面材质" aria-pressed={glass.mode === 'optical'} title={glass.mode === 'solid' && appearance.material !== 'solid' ? '点击启用玻璃；浏览器支持及系统高对比度限制仍然有效' : '点击切换玻璃与实色'} onClick={() => appearance.setMaterial(glass.mode === 'optical' ? 'solid' : 'glass')}><Icon name="palette" size={17} /><span>{materialLabel}</span></GlassButton>
          <GlassButton className="workbench-status-control" aria-label="系统状态" onClick={() => setSystemOpen(true)} disabled={!snapshot}><span className={`studio-status-dot ${issues ? 'has-issue' : ''}`} /><span>系统状态</span>{issues ? <small>{issues}</small> : null}</GlassButton>
          <GlassButton className="studio-icon-button" aria-label="偏好设置" title="偏好设置" onClick={() => workspace.setSettingsOpen(true)} disabled={!snapshot}><Icon name="settings" /></GlassButton>
        </div>
      </div>
    </GlassSurface>

    <main className="studio-content workbench-main" aria-label="工作台">
      <h1 className="studio-visually-hidden">Whisper Studio 工作台</h1>
      {!snapshot ? <section className="studio-startup" aria-live="polite"><Icon name={workspace.loadError ? 'warning' : 'waveform'} size={40} /><h2>{workspace.loadError ? '暂时无法连接工作台' : '正在连接工作台'}</h2><p>{workspace.loadError || '正在读取任务与运行环境。'}</p>{workspace.loadError ? <GlassButton onClick={() => void workspace.reload()}>重新连接</GlassButton> : null}</section> : <div className="workbench-grid">
        <GlassSurface className="workbench-pane workbench-input-pane" as="section" radius={30} refractionHeight={22} refractionAmount={34} draggable id="workbench-import" aria-labelledby="workbench-import-heading">
          {caption('导入媒体', 'workbench-import-heading', '链接 · 本地文件')}
          <ImportSheet workspace={workspace} variant="inline" />
        </GlassSurface>
        <GlassSurface className="workbench-pane workbench-activity-pane" as="section" radius={30} refractionHeight={22} refractionAmount={34} draggable aria-labelledby="workbench-activity-heading">
          {caption('任务', 'workbench-activity-heading', `${snapshot.tasks.length} 个任务`)}
          <ActivityRail workspace={workspace} onSelectTask={selectTask} onSelectHistory={selectHistory} />
        </GlassSurface>
        <GlassSurface className="workbench-pane workbench-result-pane" as="section" radius={30} refractionHeight={22} refractionAmount={34} draggable id="workbench-result" aria-labelledby="workbench-result-heading" tabIndex={-1}>
          {caption('结果', 'workbench-result-heading', '转写 · 翻译 · 导出')}
          <div className="workbench-reading-scroll">{record ? <Reader key={`${workspace.activity.view}:${record.id}`} workspace={workspace} embedded /> : <div className="workbench-empty"><Icon name="waveform" size={38} /><h3>让声音变成文字</h3><p>从左侧添加媒体，或选择一个任务。<br />转写、译文、字幕与日志会显示在这里。</p><GlassButton onClick={focusImport}><Icon name="upload" size={17} />添加媒体</GlassButton></div>}</div>
        </GlassSurface>
      </div>}
    </main>
    <footer className="studio-footer workbench-footer"><span>{snapshot ? `${snapshot.settings.transcriptionEngine} · ${snapshot.settings.whisperModel}` : '本地工作台'}<span className="workbench-footer-separator">·</span>媒体保存在运行主机</span><span>按住面板标题可拖动<span className="workbench-footer-separator">·</span>Alt + N 添加媒体</span></footer>
    <nav className="workbench-mobile-jumps" aria-label="工作台定位"><a href="#workbench-import" onClick={(event) => { event.preventDefault(); focusImport(); }}>导入</a><a href="#workbench-activity-heading">任务</a><a href="#workbench-result" onClick={(event) => { event.preventDefault(); document.getElementById('workbench-result')?.scrollIntoView({ block: 'start' }); }}>结果</a></nav>
    {workspace.settingsOpen && snapshot ? <Preferences workspace={workspace} appearance={appearance} onClose={() => workspace.setSettingsOpen(false)} /> : null}
    {systemOpen && snapshot ? <SystemPanel workspace={workspace} onClose={() => setSystemOpen(false)} onPreferences={() => { setSystemOpen(false); workspace.setSettingsOpen(true); }} /> : null}
    {workspace.confirmation ? <Confirmation workspace={workspace} /> : null}
    {workspace.isDragging ? <div className="studio-drop" aria-live="polite"><GlassSurface className="studio-drop-card" radius={32}><Icon name="upload" size={38} /><h2>松开，添加媒体</h2><p>使用当前的语言与翻译选项。</p></GlassSurface></div> : null}
    <Notifications toasts={workspace.toasts} />
  </div>;
}

export default App;
