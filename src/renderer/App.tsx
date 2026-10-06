import { AnimatePresence, motion } from 'framer-motion';
import type { DragEvent, PointerEvent } from 'react';
import { useRef } from 'react';

import ActivityPanel from './components/ActivityPanel';
import AppFooter from './components/AppFooter';
import AppHeader from './components/AppHeader';
import ConfirmDialog from './components/ConfirmDialog';
import EnvironmentBanner from './components/EnvironmentBanner';
import Icon from './components/Icon';
import InputComposer from './components/InputComposer';
import LiquidBackdrop from './components/LiquidBackdrop';
import SettingsModal from './components/SettingsModal';
import StartupState from './components/StartupState';
import TaskDetail from './components/TaskDetail';
import ToastStack from './components/ToastStack';
import { useWhisperWorkspace } from './hooks/useWhisperWorkspace';
import { fadeUpVariants, staggerContainerVariants } from './motion';

function App(): React.JSX.Element {
  const workspace = useWhisperWorkspace();
  const dragDepth = useRef(0);
  const snapshot = workspace.snapshot;

  function handlePointerMove(event: PointerEvent<HTMLElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--pointer-x', `${event.clientX - bounds.left}px`);
    event.currentTarget.style.setProperty('--pointer-y', `${event.clientY - bounds.top}px`);
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
      onPointerMove={handlePointerMove}
    >
      <LiquidBackdrop wallpaperUrl={workspace.wallpaperUrl} />

      {snapshot ? (
        <motion.div
          animate="visible"
          className="desktop-shell"
          initial="hidden"
          variants={staggerContainerVariants}
        >
          <AppHeader
            activeTaskCount={workspace.activeTaskCount}
            activeTranslationServiceId={snapshot.settings.activeTranslationServiceId}
            historyCount={snapshot.history.length}
            onChangeService={(serviceId) => void workspace.changeTranslationService(serviceId)}
            onOpenSettings={() => workspace.setSettingsOpen(true)}
            queueCount={snapshot.tasks.length}
            serviceBusy={workspace.savingServiceId !== null}
            translationServices={snapshot.settings.translationServices}
          />

          <motion.div className="environment-slot" variants={fadeUpVariants}>
            <EnvironmentBanner environment={snapshot.environment} />
          </motion.div>

          <motion.section className="workspace-grid" variants={fadeUpVariants}>
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

            <ActivityPanel
              history={snapshot.history}
              onCancelTask={(taskId) => void workspace.cancelTask(taskId)}
              onChangeView={workspace.setActivityView}
              onClearHistory={workspace.requestClearHistory}
              onRemoveHistory={(historyId) => void workspace.removeHistory(historyId)}
              onRemoveTask={(taskId) => void workspace.removeTask(taskId)}
              onRetryTask={(taskId) => void workspace.retryTask(taskId)}
              onRevealHistory={(targetPath) => void workspace.revealPath(targetPath)}
              onSelectHistory={workspace.setSelectedHistoryId}
              onSelectTask={workspace.setSelectedTaskId}
              selectedHistoryId={workspace.activity.selectedHistoryId}
              selectedTaskId={workspace.activity.selectedTaskId}
              tasks={snapshot.tasks}
              view={workspace.activity.view}
            />

            <section className="result-stage">
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
          </motion.section>

          <motion.div variants={fadeUpVariants}>
            <AppFooter {...workspace.footer} />
          </motion.div>
        </motion.div>
      ) : (
        <StartupState error={workspace.loadError} onRetry={() => void workspace.reload()} />
      )}

      <AnimatePresence>
        {workspace.settingsOpen && snapshot ? (
          <SettingsModal
            key="settings"
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
            animate={{ opacity: 1, scale: 1 }}
            className="drop-overlay"
            exit={{ opacity: 0, scale: 0.98 }}
            initial={{ opacity: 0, scale: 0.98 }}
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
