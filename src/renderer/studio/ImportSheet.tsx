import { useEffect, useRef, useState } from 'react';

import { TRANSCRIPTION_LANGUAGE_OPTIONS } from '../../shared/constants';
import { extractLinksFromText } from '../../shared/link-parser';
import type { DownloadBehavior, TranscriptionLanguage, VideoQualityOption } from '../../shared/types';
import Icon from '../components/Icon';
import { GlassButton, GlassSelect, GlassSurface } from '../glass';
import GlassSegmentedControl from '../glass/GlassSegmentedControl';
import GlassSwitch from '../glass/GlassSwitch';
import { useContentTransition } from '../lens/useContentTransition';
import { useDialogInteraction } from '../hooks/useDialogInteraction';
import type { WhisperWorkspaceController } from '../hooks/useWhisperWorkspace';
import { videoQualityLabels } from '../utils';
import { isImportError, matchesImportedFile } from './content/import-result';

export interface ImportSheetProps {
  workspace: WhisperWorkspaceController;
  onClose?: () => void;
  variant?: 'dialog' | 'inline';
}

interface ImportAttempt {
  taskIds: Set<string>;
  toastIds: Set<string>;
  links?: Set<string>;
  fileNames?: string[];
  source: 'link' | 'file';
  settled: boolean;
}

const noClose = (): void => {};

export default function ImportSheet({ workspace, onClose = noClose, variant = 'dialog' }: ImportSheetProps): React.JSX.Element {
  const inline = variant === 'inline';
  const [source, setSource] = useState<'links' | 'files'>('links');
  const [dropActive, setDropActive] = useState(false);
  const [attempt, setAttempt] = useState<ImportAttempt | null>(null);
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useDialogInteraction(panelRef, { onDismiss: onClose, enabled: !inline, initialFocusRef: inputRef });
  const { composer } = workspace;
  const sourceContent = useContentTransition(source, source);
  const optionsContent = useContentTransition({ source, behavior: composer.downloadBehavior, translate: composer.translateNext }, `${source}:${composer.downloadBehavior}:${composer.translateNext}`);
  const displayedSource = sourceContent.displayedValue;
  const optionSource = optionsContent.displayedValue.source;
  const translating = optionsContent.displayedValue.behavior !== 'downloadOnly';
  const downloading = optionsContent.displayedValue.behavior !== 'transcribe';
  const linkCount = extractLinksFromText(composer.linkInput).length;
  const services = workspace.snapshot?.settings.translationServices.filter((service) => service.enabled) ?? [];
  const activeServiceId = workspace.snapshot?.settings.activeTranslationServiceId ?? '';
  const activeService = workspace.snapshot?.settings.translationServices.find((service) => service.id === activeServiceId);
  const switchingService = Boolean(workspace.savingServiceId);
  const busy = importing || composer.busy || switchingService;

  useEffect(() => {
    if (!attempt?.settled) return;
    // Creation updates both the snapshot and selection before its promise settles.
    // An unrelated SSE addition does not select a task and is not import success.
    const created = workspace.snapshot?.tasks.find((task) => task.id === workspace.activity.selectedTaskId);
    const failed = workspace.toasts.some((toast) => !attempt.toastIds.has(toast.id) && isImportError(toast, attempt.source));
    const matchingFile = matchesImportedFile(created, attempt.fileNames);
    const succeeded = !failed && workspace.activity.view === 'queue' && created && !attempt.taskIds.has(created.id)
      && created.sourceType === attempt.source && (!attempt.links || attempt.links.has(created.input)) && matchingFile;
    setAttempt(null);
    if (succeeded && !inline) closeRef.current();
  }, [attempt, inline, workspace.snapshot?.tasks, workspace.activity.selectedTaskId, workspace.activity.view, workspace.toasts]);

  const beginImport = (kind: 'link' | 'file', files?: File[]): boolean => {
    if (importingRef.current || composer.busy || switchingService) return false;
    importingRef.current = true;
    setImporting(true);
    setAttempt({
      taskIds: new Set(workspace.snapshot?.tasks.map((task) => task.id) ?? []),
      toastIds: new Set(workspace.toasts.map((toast) => toast.id)),
      links: kind === 'link' ? new Set(extractLinksFromText(composer.linkInput)) : undefined,
      fileNames: files?.map((file) => file.name),
      source: kind,
      settled: false
    });
    return true;
  };
  const endImport = (): void => {
    importingRef.current = false;
    setImporting(false);
    setAttempt((current) => current ? { ...current, settled: true } : null);
  };
  const submitLinks = async (): Promise<void> => {
    if (!linkCount || !beginImport('link')) return;
    try { await workspace.addLinks(); } finally { endImport(); }
  };
  const chooseFiles = (): void => {
    if (!busy) fileRef.current?.click();
  };
  const importDroppedFiles = async (files: File[]): Promise<void> => {
    if (!files.length || !beginImport('file', files)) return;
    try { await workspace.addDroppedFiles(files); } finally { endImport(); }
  };

  return (
    <div className={inline ? 'studio-import-inline' : 'studio-modal-backdrop studio-import-backdrop'} onPointerDown={inline ? undefined : (event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="studio-import-sheet" ref={panelRef} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : true} aria-labelledby="studio-import-title" tabIndex={inline ? undefined : -1}>
        {inline ? <header className="studio-import-header"><h2 id="studio-import-title">添加媒体</h2><span>链接与文件直接加入队列</span></header> : <GlassSurface className="studio-import-header" as="header" radius={26} tone="strong"><div><p className="studio-eyebrow">添加媒体</p><h2 id="studio-import-title">新建任务</h2></div><GlassButton onClick={onClose} aria-label="关闭新建任务"><Icon name="close" /></GlassButton></GlassSurface>}
        <form className="studio-import-form" onSubmit={(event) => { event.preventDefault(); if (source === 'links') void submitLinks(); else void chooseFiles(); }} aria-busy={busy}>
          <fieldset className="studio-import-controls" disabled={busy}>
          <input ref={fileRef} type="file" accept="audio/*,video/*,.mkv,.flac,.m4a,.webm" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void importDroppedFiles(files); }} />
          <GlassSegmentedControl className="studio-import-source" label="媒体来源" value={source} disabled={busy} onChange={(value) => { if (value === 'files' && composer.downloadBehavior === 'downloadOnly') workspace.setDownloadBehavior('transcribe'); setSource(value as 'links' | 'files'); }} options={[{ value: 'links', label: '在线链接' }, { value: 'files', label: '本地文件' }]} />
          <div className="lens-content-transition studio-import-content" ref={sourceContent.contentRef}>
          {displayedSource === 'links' ? <div className="studio-import-link-field"><label htmlFor="studio-link-input">粘贴链接或分享文案</label><textarea autoCapitalize="off" autoCorrect="off" id="studio-link-input" ref={inputRef} rows={4} placeholder="YouTube、B 站、抖音…\n可以一次添加多个链接" value={composer.linkInput} onChange={(event) => workspace.setLinkInput(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submitLinks(); } }} spellCheck={false} aria-describedby="studio-import-link-help" /><div className="studio-field-hint" id="studio-import-link-help"><span>{linkCount ? `已识别 ${linkCount} 个链接` : '自动从分享文案中提取媒体链接'}</span><span>Ctrl / ⌘ + Enter 添加</span></div></div> : <div className={`studio-file-drop${dropActive ? ' is-active' : ''}`} onDragEnter={(event) => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.stopPropagation(); setDropActive(true); } }} onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDropActive(false); void importDroppedFiles(Array.from(event.dataTransfer.files)); }}><Icon name="upload" size={36} /><strong>将音频或视频拖到这里</strong><p>也可以从电脑选择多个媒体文件。</p><GlassButton disabled={composer.busy} onClick={() => void chooseFiles()} type="button"><Icon name="folder" />选择文件</GlassButton></div>}

          {displayedSource === 'links' ? inline ? <div className="studio-field studio-import-processing"><span>处理方式</span><GlassSegmentedControl label="处理方式" value={composer.downloadBehavior} disabled={busy} onChange={(value) => workspace.setDownloadBehavior(value as DownloadBehavior)} options={[{ value: 'transcribe', label: '生成文字' }, { value: 'downloadThenTranscribe', label: '保存并转写' }, { value: 'downloadOnly', label: '仅下载' }]} /></div> : <fieldset className="studio-import-mode"><legend>你想做什么？</legend><div>{([{ value: 'transcribe', title: '生成文字', hint: '识别语音，生成文本与字幕', icon: 'waveform' }, { value: 'downloadThenTranscribe', title: '保存并转写', hint: '保留媒体，同时生成文字', icon: 'download' }, { value: 'downloadOnly', title: '只保存媒体', hint: '下载视频或音频文件', icon: 'file' }] as const).map((option) => <label key={option.value} className={composer.downloadBehavior === option.value ? 'is-selected' : ''}><input type="radio" name="processing-mode" value={option.value} checked={composer.downloadBehavior === option.value} onChange={() => workspace.setDownloadBehavior(option.value as DownloadBehavior)} /><Icon name={option.icon} size={22} /><strong>{option.title}</strong><small>{option.hint}</small></label>)}</div></fieldset> : null}
          </div>
          <div className="lens-content-transition studio-import-content" ref={optionsContent.contentRef}>
          <div className="studio-import-options">
            {(optionSource === 'files' || translating) ? <label className="studio-field"><span>音频语言</span><GlassSelect label="音频语言" disabled={busy} value={composer.transcriptionLanguage} onChange={(value) => workspace.setTranscriptionLanguage(value as TranscriptionLanguage)} options={TRANSCRIPTION_LANGUAGE_OPTIONS} /><small>混合语言建议自动检测。</small></label> : null}
            {optionSource === 'links' && downloading ? <label className="studio-field"><span>下载规格</span><GlassSelect label="下载规格" disabled={busy} value={composer.videoQuality} onChange={(value) => workspace.setVideoQuality(value as VideoQualityOption)} options={(['best', '1080p', '720p', '480p', 'audio'] as const).map((quality) => ({ value: quality, label: videoQualityLabels[quality] }))} /><small>保存视频或仅下载音频。</small></label> : null}
          </div>
          {(optionSource === 'files' || translating) ? <>
          <label className="studio-import-translation"><span><Icon name="translate" /><span><strong>同时翻译成中文</strong><small>{activeService ? `转写后使用 ${activeService.name}。` : '转写后生成中文译文。'}</small></span></span><GlassSwitch label="同时翻译成中文" checked={composer.translateNext} disabled={busy} onChange={workspace.setTranslateNext} /></label>
          {optionsContent.displayedValue.translate ? <div className="studio-import-service">
            {services.length ? <label className="studio-field"><span>翻译服务</span><GlassSelect label="新任务翻译服务" disabled={busy} value={activeServiceId} onChange={(value) => void workspace.changeTranslationService(value)} options={[...(!services.some((service) => service.id === activeServiceId) ? [{ value: activeServiceId, disabled: true, label: activeService ? `${activeService.name}（已停用）` : '请选择翻译服务' }] : []), ...services.map((service) => ({ value: service.id, label: `${service.name} · ${service.model}` }))]} /><small>{switchingService ? '正在切换服务，完成后即可添加任务。' : '服务切换立即生效，新任务使用所选服务。'}</small></label> : <p>还没有可用的翻译服务。</p>}
            <button className="studio-text-button" onClick={() => workspace.setSettingsOpen(true)} type="button">配置翻译服务<Icon name="external" size={15} /></button>
          </div> : null}
          </> : null}
          </div>
          </fieldset>
          <footer className="studio-import-footer"><p>任务加入后持续在后台处理。<br />你可以随时添加下一项媒体。</p><GlassButton className="studio-primary" disabled={busy || source === 'links' && !linkCount} type="submit">{switchingService ? '正在切换服务…' : busy ? '正在添加…' : source === 'links' ? `添加${linkCount > 1 ? ` ${linkCount} 个` : ''}任务` : '选择文件并添加'}<Icon name="queue" /></GlassButton></footer>
        </form>
      </div>
    </div>
  );
}
