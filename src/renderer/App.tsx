import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';

import Icon from './components/Icon';
import { GlassButton, GlassSurface } from './glass';
import { useAppearance } from './hooks/useAppearance';
import { useInteractionModality } from './hooks/useInteractionModality';
import { useWhisperWorkspace } from './hooks/useWhisperWorkspace';
import ImportSheet from './studio/ImportSheet';
import Library from './studio/Library';
import Preferences from './studio/Preferences';
import Reader from './studio/Reader';
import { Confirmation, Notifications, SystemPanel } from './studio/SystemPanel';
import { parseStudioRoute, routeHash, type StudioRoute } from './studio/navigation';

function App(): React.JSX.Element {
  const workspace = useWhisperWorkspace();
  const appearance = useAppearance();
  useInteractionModality();
  const [route, setRoute] = useState<StudioRoute>(() => parseStudioRoute(window.location.hash));
  const [importOpen, setImportOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const consumingDrop = useRef(false);
  const dragDepth = useRef(0);
  const mainRef = useRef<HTMLElement>(null);
  const lastRoute = useRef(routeHash(route));
  const seenRecordRoute = useRef<string | null>(null);
  const snapshot = workspace.snapshot;

  function navigate(next: StudioRoute): void {
    const hash = routeHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute(next);
  }

  function openTask(id: string): void {
    workspace.setActivityView('queue');
    workspace.setSelectedTaskId(id);
    navigate({ kind: 'task', id });
  }

  function openHistory(id: string): void {
    workspace.setActivityView('history');
    workspace.setSelectedHistoryId(id);
    navigate({ kind: 'history', id });
  }

  useEffect(() => {
    const changed = (): void => setRoute(parseStudioRoute(window.location.hash));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  useEffect(() => {
    if (route.kind === 'task') {
      workspace.setActivityView('queue');
      workspace.setSelectedTaskId(route.id);
    } else if (route.kind === 'history') {
      workspace.setActivityView('history');
      workspace.setSelectedHistoryId(route.id);
    }
  }, [route, workspace.setActivityView, workspace.setSelectedHistoryId, workspace.setSelectedTaskId]);

  useLayoutEffect(() => {
    const key = routeHash(route);
    if (lastRoute.current === key) return;
    lastRoute.current = key;
    window.scrollTo({ top: 0, behavior: 'instant' });
    mainRef.current?.focus({ preventScroll: true });
  }, [route]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      const editable = event.target instanceof HTMLElement &&
        (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setImportOpen(true);
      } else if (event.key === '/' && !editable && route.kind === 'library') {
        const search = document.querySelector<HTMLInputElement>('.studio-library input[type="search"]');
        if (search) { event.preventDefault(); search.focus(); }
      } else if (event.key === 'Escape' && !editable && route.kind !== 'library') {
        event.preventDefault();
        navigate({ kind: 'library' });
      }
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [route]);

  function dragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    workspace.setIsDragging(true);
  }

  function dragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) workspace.setIsDragging(false);
  }

  function drop(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current = 0;
    workspace.setIsDragging(false);
    const files = Array.from(event.dataTransfer.files);
    // A local file always enters the transcription flow. Changing this first
    // lets the preserved controller see the mode on its next render.
    if (workspace.composer.downloadBehavior === 'downloadOnly') {
      workspace.setDownloadBehavior('transcribe');
      consumingDrop.current = false;
      setDroppedFiles(files);
    } else void workspace.addDroppedFiles(files);
  }

  useEffect(() => {
    if (!droppedFiles || consumingDrop.current || workspace.composer.downloadBehavior === 'downloadOnly') return;
    consumingDrop.current = true;
    setDroppedFiles(null);
    void workspace.addDroppedFiles(droppedFiles);
  }, [droppedFiles, workspace.composer.downloadBehavior, workspace.addDroppedFiles]);

  useEffect(() => {
    const clear = (): void => { dragDepth.current = 0; workspace.setIsDragging(false); };
    window.addEventListener('blur', clear);
    window.addEventListener('dragend', clear);
    return () => { window.removeEventListener('blur', clear); window.removeEventListener('dragend', clear); };
  }, [workspace.setIsDragging]);

  const readerTask = route.kind === 'task' ? snapshot?.tasks.find((item) => item.id === route.id)
    : route.kind === 'history' ? snapshot?.tasks.find((item) => item.id === route.id) : undefined;
  const readerHistory = route.kind === 'history' ? snapshot?.history.find((item) => item.id === route.id) : undefined;
  const recordExists = route.kind === 'library' || (route.kind === 'task' ? Boolean(readerTask) : Boolean(readerHistory));
  const missingRecord = snapshot && !recordExists;
  useLayoutEffect(() => {
    const key = routeHash(route);
    if (route.kind === 'library') { seenRecordRoute.current = null; return; }
    if (recordExists) seenRecordRoute.current = key;
    else if (snapshot && seenRecordRoute.current === key) {
      seenRecordRoute.current = null;
      const library = { kind: 'library' } as const;
      window.history.replaceState(null, '', routeHash(library));
      setRoute(library);
    }
  }, [route, recordExists, snapshot]);
  const readerWorkspace = {
    ...workspace,
    activity: { ...workspace.activity, activeTask: readerTask, activeHistoryRecord: readerHistory }
  };
  const environmentIssues = snapshot?.environment.items.filter((item) => !item.ok).length ?? 0;

  return (
    <div className="studio-root" onDragEnter={dragEnter} onDragLeave={dragLeave}
      onDropCapture={(event) => { if (event.dataTransfer.types.includes('Files')) { dragDepth.current = 0; workspace.setIsDragging(false); } }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={drop}>
      <a className="studio-skip" href="#studio-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); mainRef.current?.scrollIntoView({ block: 'start' }); }}>跳转到内容</a>
      <div aria-hidden="true" className="studio-landscape">
        {workspace.wallpaperUrl ? <div className="studio-wallpaper" style={{ backgroundImage: `url(${JSON.stringify(workspace.wallpaperUrl)})` }} /> : null}
      </div>
      <GlassSurface as="header" className="studio-header" radius={28} refractionAmount={24}>
        <div className="studio-header-content">
          <button className="studio-brand" onClick={() => navigate({ kind: 'library' })} type="button" aria-label="Whisper Studio 媒体库">
            <span className="studio-brand-mark"><Icon name="waveform" size={24} /></span>
            <span>Whisper <strong>Studio</strong></span>
          </button>
          <nav className="studio-nav" aria-label="工作台导航">
            <button aria-current={route.kind === 'library' ? 'page' : undefined} onClick={() => navigate({ kind: 'library' })} type="button">媒体库</button>
            <button onClick={() => setSystemOpen(true)} type="button" className="studio-status-trigger">
              <span className={`studio-status-dot ${environmentIssues ? 'has-issue' : ''}`} aria-hidden="true" />
              <span>系统状态</span>
              {environmentIssues ? <small>{environmentIssues}</small> : null}
            </button>
          </nav>
          <div className="studio-header-actions">
            <GlassButton aria-label="偏好设置" title="偏好设置" className="studio-icon-button" onClick={() => workspace.setSettingsOpen(true)} disabled={!snapshot}><Icon name="settings" /></GlassButton>
            <GlassButton className="studio-primary studio-new-button" onClick={() => setImportOpen(true)} disabled={!snapshot} aria-keyshortcuts="Alt+N"><Icon name="upload" size={17} /><span>新建任务</span></GlassButton>
          </div>
        </div>
      </GlassSurface>

      <main id="studio-content" className="studio-content" ref={mainRef} tabIndex={-1}>
        {!snapshot ? (
          <section className="studio-startup" aria-live="polite">
            <Icon name={workspace.loadError ? 'warning' : 'waveform'} size={40} />
            <h1>{workspace.loadError ? '暂时无法连接工作台' : '正在连接工作台'}</h1>
            <p>{workspace.loadError || '正在读取任务与运行环境。'}</p>
            {workspace.loadError ? <GlassButton className="studio-primary" onClick={() => void workspace.reload()}><Icon name="retry" />重新连接</GlassButton> : null}
          </section>
        ) : missingRecord ? (
          <section className="studio-startup">
            <Icon name="file" size={40} />
            <h1>这个记录已不在媒体库中</h1>
            <p>记录可能已被移除。你可以返回查看其他任务。</p>
            <GlassButton onClick={() => navigate({ kind: 'library' })}>返回媒体库</GlassButton>
          </section>
        ) : route.kind === 'library' ? (
          <Library workspace={workspace} onOpenTask={openTask} onOpenHistory={openHistory} onNew={() => setImportOpen(true)} />
        ) : (
          <Reader key={`${route.kind}:${route.id}`} workspace={readerWorkspace} onBack={() => navigate({ kind: 'library' })} />
        )}
      </main>

      {snapshot ? <footer className="studio-footer"><span>本地工作台 · 媒体保存在运行主机</span><span aria-live="polite">{workspace.activeTaskCount ? `${workspace.activeTaskCount} 个任务正在处理` : '准备就绪'}</span></footer> : null}

      {importOpen && snapshot ? <ImportSheet workspace={workspace} onClose={() => setImportOpen(false)} /> : null}
      {workspace.settingsOpen && snapshot ? <Preferences workspace={workspace} appearance={appearance} onClose={() => workspace.setSettingsOpen(false)} /> : null}
      {systemOpen && snapshot ? <SystemPanel workspace={workspace} onClose={() => setSystemOpen(false)} onPreferences={() => { setSystemOpen(false); workspace.setSettingsOpen(true); }} /> : null}
      {workspace.confirmation ? <Confirmation workspace={workspace} /> : null}
      {workspace.isDragging ? <div className="studio-drop" aria-live="polite"><GlassSurface className="studio-drop-card" radius={32}><Icon name="upload" size={38} /><h2>松开，添加到工作台</h2><p>音频与视频都会使用当前任务选项。</p></GlassSurface></div> : null}
      <Notifications toasts={workspace.toasts} />
    </div>
  );
}

export default App;
