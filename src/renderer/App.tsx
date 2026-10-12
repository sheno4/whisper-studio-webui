import { AnimatePresence, motion } from 'framer-motion';
import type { DragEvent } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

import ActivityPanel from './components/ActivityPanel';
import AppFooter from './components/AppFooter';
import AppHeader from './components/AppHeader';
import ConfirmDialog from './components/ConfirmDialog';
import EnvironmentBanner from './components/EnvironmentBanner';
import Icon from './components/Icon';
import InputComposer from './components/InputComposer';
import LiquidBackdrop from './components/LiquidBackdrop';
import ModelPreparationPanel from './components/ModelPreparationPanel';
import SettingsModal from './components/SettingsModal';
import StartupState from './components/StartupState';
import TaskDetail from './components/TaskDetail';
import ToastStack from './components/ToastStack';
import { useWhisperWorkspace } from './hooks/useWhisperWorkspace';
import { useAppearance } from './hooks/useAppearance';
import { useInteractionModality } from './hooks/useInteractionModality';
import { quickTransition } from './motion';

function App(): React.JSX.Element {
  const workspace = useWhisperWorkspace();
  const appearance = useAppearance();
  useInteractionModality();
  const [mobilePane, setMobilePane] = useState<'import' | 'tasks' | 'results'>('import');
  const [importExpanded, setImportExpanded] = useState(true);
  const focusResultAfterSelection = useRef(false);
  const dragDepth = useRef(0);
  const snapshot = workspace.snapshot;

  useLayoutEffect(() => {
    if (!focusResultAfterSelection.current) return;
    focusResultAfterSelection.current = false;
    document.getElementById('result-stage')?.focus({ preventScroll: true });
  }, [mobilePane]);

  function selectTask(taskId: string): void {
    workspace.setSelectedTaskId(taskId);
    if (window.matchMedia('(max-width: 900px)').matches) {
      focusResultAfterSelection.current = true;
      setMobilePane('results');
    }
  }

  function selectHistory(historyId: string): void {
    workspace.setSelectedHistoryId(historyId);
    if (window.matchMedia('(max-width: 900px)').matches) {
      focusResultAfterSelection.current = true;
      setMobilePane('results');
    }
  }

  function handleDragEnter(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    if (!event.dataTransfer.types.includes('Files')) {
      return;
    }

    dragDepth.current += 1;
    workspace.setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      workspace.setIsDragging(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    dragDepth.current = 0;
    workspace.setIsDragging(false);
    void workspace.addDroppedFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <main
      className={`app-root ${workspace.isDragging ? 'is-dragging' : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <a className="skip-link" href="#workspace-content">跳转到工作台</a>
      <LiquidBackdrop wallpaperUrl={workspace.wallpaperUrl} />

      {snapshot ? (
        <div
          className="desktop-shell"
          data-mobile-pane={mobilePane}
        >
          <AppHeader
            appearance={appearance.appearance}
            material={appearance.material}
            activeTaskCount={workspace.activeTaskCount}
            activeTranslationServiceId={snapshot.settings.activeTranslationServiceId}
            historyCount={snapshot.history.length}
            onChangeService={(serviceId) => void workspace.changeTranslationService(serviceId)}
            onOpenSettings={() => workspace.setSettingsOpen(true)}
            onCycleAppearance={appearance.cycleAppearance}
            onToggleMaterial={appearance.toggleMaterial}
            queueCount={snapshot.tasks.length}
            serviceBusy={workspace.savingServiceId !== null}
            translationServices={snapshot.settings.translationServices}
          />

          <div className="environment-slot">
            <EnvironmentBanner environment={snapshot.environment} />
            <ModelPreparationPanel preparations={snapshot.modelPreparations} settings={snapshot.settings} />
          </div>

          <section className="workspace-grid" id="workspace-content" aria-label="音视频工作台" tabIndex={-1}>
            <aside className="workspace-sidebar" aria-label="导入与任务">
              <details className="workspace-import" open={importExpanded} onToggle={(event) => setImportExpanded(event.currentTarget.open)}>
                <summary className="workspace-import-toggle">
                  <Icon name="upload" size={17} />
                  <span>新建任务</span>
                  <Icon className="workspace-import-caret" name="chevron-down" size={16} />
                </summary>
                <section className="import-stage" id="import-stage" aria-label="新建任务">
                  <InputComposer
                    busy={workspace.composer.busy}
                    downloadBehavior={workspace.composer.downloadBehavior}
                    linkInput={workspace.composer.linkInput}
                    onAddLinks={() => void workspace.addLinks()}
                    onDownloadBehaviorChange={workspace.setDownloadBehavior}
                    onLinkInputChange={workspace.setLinkInput}
                    onPickFiles={() => void workspace.pickFiles()}
                    onToggleTranslate={workspace.setTranslateNext}
                    onTranscriptionLanguageChange={workspace.setTranscriptionLanguage}
                    onVideoQualityChange={workspace.setVideoQuality}
                    transcriptionLanguage={workspace.composer.transcriptionLanguage}
                    translateNext={workspace.composer.translateNext}
                    videoQuality={workspace.composer.videoQuality}
                  />
                </section>
              </details>

              <section className="activity-stage" id="activity-stage" aria-label="任务中心">
                <ActivityPanel
                  history={snapshot.history}
                  onCancelTask={(taskId) => void workspace.cancelTask(taskId)}
                  onChangeView={workspace.setActivityView}
                  onClearHistory={workspace.requestClearHistory}
                  onRemoveHistory={(historyId) => void workspace.removeHistory(historyId)}
                  onRemoveTask={(taskId) => void workspace.removeTask(taskId)}
                  onRetryTask={(taskId) => void workspace.retryTask(taskId)}
                  onRevealHistory={(targetPath) => void workspace.revealPath(targetPath)}
                  onSelectHistory={selectHistory}
                  onSelectTask={selectTask}
                  selectedHistoryId={workspace.activity.selectedHistoryId}
                  selectedTaskId={workspace.activity.selectedTaskId}
                  tasks={snapshot.tasks}
                  view={workspace.activity.view}
                />
              </section>
            </aside>

            <section className="result-stage" id="result-stage" aria-label="任务结果" tabIndex={-1}>
              <TaskDetail
                historyRecord={workspace.activity.activeHistoryRecord}
                onCopy={(text, label) => void workspace.copyText(text, label)}
                onDeleteDirectory={workspace.requestDeleteTaskDirectory}
                onExport={(taskId, kind) => void workspace.exportTaskFile(taskId, kind)}
                onOpenOutputDir={(taskId) => void workspace.openOutputDirectory(taskId)}
                onOpenSource={(taskId) => void workspace.openSourceLocation(taskId)}
                onRemoveHistory={(historyId) => void workspace.removeHistory(historyId)}
                onRevealPath={(targetPath) => void workspace.revealPath(targetPath)}
                task={workspace.activity.activeTask}
              />
            </section>
          </section>

          <div className="footer-slot">
            <AppFooter {...workspace.footer} />
          </div>
          <nav className="mobile-workspace-nav glass-chrome" aria-label="工作台区域">
            {([
              { value: 'import', label: '新任务', icon: 'upload', target: 'import-stage' },
              { value: 'tasks', label: '任务', icon: 'queue', target: 'activity-stage' },
              { value: 'results', label: '结果', icon: 'file', target: 'result-stage' }
            ] as const).map((item) => (
              <button
                aria-controls={item.target}
                aria-pressed={mobilePane === item.value}
                className={mobilePane === item.value ? 'is-active' : ''}
                key={item.value}
                onClick={() => {
                  setMobilePane(item.value);
                  if (item.value === 'import') setImportExpanded(true);
                }}
                type="button"
              >
                <Icon name={item.icon} size={19} />
                <span>{item.label}</span>
                {item.value === 'tasks' && workspace.activeTaskCount > 0 ? <small>{workspace.activeTaskCount}</small> : null}
              </button>
            ))}
          </nav>
        </div>
      ) : (
        <StartupState error={workspace.loadError} onRetry={() => void workspace.reload()} />
      )}

      <AnimatePresence>
        {workspace.settingsOpen && snapshot ? (
          <SettingsModal
            key="settings"
            modelPreparations={snapshot.modelPreparations}
            onClose={() => workspace.setSettingsOpen(false)}
            onPickDirectory={() => window.whisperWeb.pickDirectory()}
            onPickWallpaper={() => window.whisperWeb.pickWallpaperFile()}
            onSave={workspace.saveSettings}
            settings={snapshot.settings}
          />
        ) : null}

        {workspace.confirmation ? (
          <ConfirmDialog
            busy={workspace.confirming}
            key="confirmation"
            onCancel={workspace.dismissConfirmation}
            onConfirm={() => void workspace.confirmAction()}
            request={workspace.confirmation}
          />
        ) : null}

        {workspace.isDragging ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="drop-overlay"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={quickTransition}
            key="drop-overlay"
          >
            <div className="drop-card glass-float">
              <span className="drop-icon"><Icon name="upload" size={26} /></span>
              <h2>松开即可导入</h2>
              <p>支持音频、视频及常见媒体文件</p>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <ToastStack toasts={workspace.toasts} />
    </main>
  );
}

export default App;
