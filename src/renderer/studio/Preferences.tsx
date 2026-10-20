import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { SaveSettingsPayload, SettingsData, TranscriptionEngine } from '../../shared/types';
import Icon from '../components/Icon';
import { GlassButton, GlassSelect, GlassSurface } from '../glass';
import { useGlassCapability } from '../glass/capabilities';
import {GlassIntensity} from '../glass/GlassIntensity';
import { useContentTransition } from '../lens/useContentTransition';
import type { useAppearance, Appearance } from '../hooks/useAppearance';
import { useDialogInteraction } from '../hooks/useDialogInteraction';
import { isKeyboardInteraction } from '../hooks/useInteractionModality';
import type { WhisperWorkspaceController } from '../hooks/useWhisperWorkspace';
import { formatDateTime, normalizeUiText, toCssFileUrl } from '../utils';
import { PreferenceField, PreferenceGroup, PreferenceToggle } from './preferences/Fields';
import ModelDownloads from './preferences/ModelDownloads';
import TranslationEditor from './preferences/TranslationEditor';
import { engineModels, modelForEngine, type PreferenceCategory } from './preferences/draft';
import { usePreferencesSession, type PreferencesSession } from './preferences/usePreferencesSession';

export interface PreferencesProps {
  workspace: WhisperWorkspaceController;
  onClose: () => void;
  appearance: ReturnType<typeof useAppearance>;
  open: boolean;
}

const categories: Array<{ id: PreferenceCategory; label: string; description: string }> = [
  { id: 'general', label: '工作方式', description: '文件保存与新任务默认行为' },
  { id: 'runtime', label: '转写与模型', description: '选择后端，准备转写模型' },
  { id: 'downloads', label: '下载', description: '并行能力与浏览器登录状态' },
  { id: 'translation', label: '翻译', description: '连接服务，配置翻译方式' },
  { id: 'appearance', label: '外观', description: '为这台设备选择合适的界面' },
  { id: 'system', label: '系统', description: '运行环境与诊断信息' }
];
const engines: Array<{ id: TranscriptionEngine; name: string; description: string }> = [
  { id: 'faster-whisper', name: 'faster-whisper', description: 'CTranslate2 后端' },
  { id: 'whisper.cpp', name: 'whisper.cpp', description: '原生后端 · Vulkan / CPU' },
  { id: 'whisper', name: 'openai-whisper', description: 'PyTorch 后端' }
];
const themeChoices: Array<{ value: Appearance; label: string }> = [{ value: 'system', label: '系统配色' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }];

function PreferencesDialog({ workspace, onClose, appearance, settings, session }: PreferencesProps & { settings: SettingsData; session: PreferencesSession }): React.JSX.Element {
  const glassCapability = useGlassCapability();
  const { draft, category, setCategory, selectedService, setSelectedService, saving, picker, error, saved, dirty, busy, update, field, reset, save, pick, cancelPicker, setError } = session;
  const categoryContent = useContentTransition(category, category);
  const displayedCategory = categoryContent.displayedValue;
  const panelRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const categoryPositions = useRef(new Map<PreferenceCategory, number>());
  const firstTabRef = useRef<HTMLButtonElement>(null);
  const [entryMotion] = useState(() => isKeyboardInteraction() ? 'instant' : 'pointer');
  const currentCategory = categories.find((item) => item.id === displayedCategory)!;
  const runtimeChanged = draft.pythonPath !== settings.pythonPath || draft.transcriptionEngine !== settings.transcriptionEngine || draft.whisperModel !== settings.whisperModel;

  const requestClose = (): void => {
    cancelPicker();
    onClose();
  };
  useDialogInteraction(panelRef, { onDismiss: requestClose, initialFocusRef: firstTabRef });

  const chooseCategory = (next: PreferenceCategory): void => {
    if (next === category) return;
    if (scrollRef.current) categoryPositions.current.set(displayedCategory, scrollRef.current.scrollTop);
    setCategory(next);
  };
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = categoryPositions.current.get(displayedCategory) ?? 0;
  }, [displayedCategory]);

  const navigateCategories = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const target = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % categories.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + categories.length) % categories.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : undefined;
    if (target === undefined) return;
    event.preventDefault();
    chooseCategory(categories[target].id);
    const tab = document.getElementById(`prefs-tab-${categories[target].id}`);
    tab?.focus({ preventScroll: true });
    const tabs = tabsRef.current;
    if (tabs && tab) {
      const viewport = tabs.getBoundingClientRect();
      const item = tab.getBoundingClientRect();
      const left = item.left < viewport.left ? item.left - viewport.left : item.right > viewport.right ? item.right - viewport.right : 0;
      const top = item.top < viewport.top ? item.top - viewport.top : item.bottom > viewport.bottom ? item.bottom - viewport.bottom : 0;
      // Reveal keyboard focus inside this navigation only, without moving the dialog or page.
      if (left || top) tabs.scrollBy({ left, top, behavior: 'auto' });
    }
  };
  const chooseTheme = (value: Appearance): void => appearance.setAppearance(value);

  const renderCategory = (): React.JSX.Element => {
    switch (displayedCategory) {
      case 'general': return <>
        <PreferenceGroup title="输出与文件" description="设置运行服务的机器上的保存位置。">
          <div className="prefs-picker"><PreferenceField label="输出目录" wide><input onChange={(event) => field('outputDir', event.target.value)} spellCheck={false} value={draft.outputDir} /></PreferenceField><GlassButton className="prefs-button" disabled={busy} onClick={() => void pick('directory')} type="button"><Icon name="folder" size={15} />{picker === 'directory' ? '选择中…' : '选择目录'}</GlassButton></div>
          <PreferenceToggle label="保留预处理音频" hint="在输出目录中保留转写使用的音频文件。" checked={draft.keepAudio} onChange={(value) => field('keepAudio', value)} />
        </PreferenceGroup>
        <PreferenceGroup title="新任务默认值"><PreferenceToggle label="默认翻译为中文" hint="新任务自动启用翻译，也可以在创建时单独调整。" checked={draft.translateByDefault} onChange={(value) => field('translateByDefault', value)} /></PreferenceGroup>
      </>;
      case 'runtime': return <>
        <PreferenceGroup title="选择转写引擎" description="切换后端时会保留兼容模型，其他模型自动调整。">
          <fieldset className="prefs-engine-choices"><legend className="prefs-sr-only">转写引擎</legend>{engines.map((engine) => <label className="lg-surface prefs-engine" data-glass="chip" key={engine.id}><input checked={draft.transcriptionEngine === engine.id} name="prefs-engine" onChange={() => update({ ...draft, transcriptionEngine: engine.id, whisperModel: modelForEngine(engine.id, draft.whisperModel) })} type="radio" value={engine.id} /><span><strong>{engine.name}</strong><small>{engine.description}</small></span></label>)}</fieldset>
          <div className="prefs-grid"><PreferenceField label="Whisper 模型" hint="保存后立即在后台准备，无需重启。"><GlassSelect label="Whisper 模型" disabled={busy} onChange={(value) => field('whisperModel', value)} value={draft.whisperModel} options={[...(!engineModels[draft.transcriptionEngine].includes(draft.whisperModel) ? [{ value: draft.whisperModel, label: `${draft.whisperModel}（自定义）` }] : []), ...engineModels[draft.transcriptionEngine].map((model) => ({ value: model, label: model }))]} /></PreferenceField><PreferenceField label="同时转写任务数" hint="多个模型实例会增加内存或显存占用。"><GlassSelect label="同时转写任务数" disabled={busy} onChange={(value) => field('maxConcurrentTranscriptions', Number(value))} value={String(draft.maxConcurrentTranscriptions)} options={[1, 2].map((count) => ({ value: String(count), label: `${count} 个` }))} /></PreferenceField><PreferenceField label="Python 路径" wide><input onChange={(event) => field('pythonPath', event.target.value)} spellCheck={false} value={draft.pythonPath} /></PreferenceField></div>
          {draft.transcriptionEngine === 'whisper.cpp' ? <p className="prefs-note">GPU 加速取决于安装的后端、驱动和设备。此后端支持 Vulkan，无法使用时可回退 CPU。</p> : null}
        </PreferenceGroup>
        <ModelDownloads preparations={workspace.snapshot?.modelPreparations ?? []} saveDraft={save} settings={settings} unsavedSelection={runtimeChanged} />
      </>;
      case 'downloads': return <>
        <PreferenceGroup title="并行下载" description="任务可以实时加入队列，下载与转写分别调度。"><div className="prefs-grid"><PreferenceField label="同时下载任务数"><GlassSelect label="同时下载任务数" disabled={busy} onChange={(value) => field('maxConcurrentDownloads', Number(value))} value={String(draft.maxConcurrentDownloads)} options={Array.from({ length: 6 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 个` }))} /></PreferenceField><PreferenceField label="每个下载的连接数" hint="网站支持分段时使用；速度同时受网络与站点限制。"><GlassSelect label="每个下载的连接数" disabled={busy} onChange={(value) => field('downloadConnections', Number(value))} value={String(draft.downloadConnections)} options={Array.from({ length: 16 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 个` }))} /></PreferenceField></div></PreferenceGroup>
        <PreferenceGroup title="YouTube 登录状态" description="会员视频使用浏览器中已登录账号的访问权限。"><PreferenceField label="登录来源" hint="自动选择时优先 Firefox。登录状态由服务在本机读取。" wide><GlassSelect label="登录来源" disabled={busy} onChange={(value) => field('youtubeCookieSource', value as SaveSettingsPayload['youtubeCookieSource'])} value={draft.youtubeCookieSource ?? 'auto'} options={[{ value: 'auto', label: '自动选择' }, { value: 'firefox', label: 'Firefox' }, { value: 'chrome', label: 'Chrome' }, { value: 'file', label: '项目目录中的 cookies.txt' }, { value: 'none', label: '不使用登录状态' }]} /></PreferenceField>{draft.youtubeCookieSource === 'firefox' || draft.youtubeCookieSource === 'chrome' ? <PreferenceField label="浏览器配置目录（可选）" hint="留空自动查找；多账号可指定对应配置目录。" wide><input onChange={(event) => field('youtubeBrowserProfile', event.target.value)} spellCheck={false} value={draft.youtubeBrowserProfile || ''} /></PreferenceField> : null}</PreferenceGroup>
      </>;
      case 'translation': return <>
        <PreferenceGroup title="翻译调度"><PreferenceField label="同时翻译任务数" hint="每个服务的请求频率限制仍然有效。"><GlassSelect label="同时翻译任务数" disabled={busy} onChange={(value) => field('maxConcurrentTranslations', Number(value))} value={String(draft.maxConcurrentTranslations)} options={[1, 2, 3, 4].map((count) => ({ value: String(count), label: `${count} 个` }))} /></PreferenceField></PreferenceGroup>
        <TranslationEditor draft={draft} select={setSelectedService} selectedId={selectedService} settings={settings} update={update} />
      </>;
      case 'appearance': return <>
        <PreferenceGroup title="界面外观" description="这些选项仅保存在此浏览器，调整后立即生效。"><fieldset className="prefs-choice-group"><legend>配色</legend>{themeChoices.map((choice) => <label className="lg-surface lg-choice" data-glass="chip" key={choice.value}><input checked={appearance.appearance === choice.value} name="prefs-theme" onChange={() => chooseTheme(choice.value)} type="radio" value={choice.value} /><span>{choice.label}</span></label>)}</fieldset><fieldset className="prefs-choice-group"><legend>界面材质</legend>{([{ value: 'glass', label: '液态玻璃' }, { value: 'solid', label: '实色' }] as const).map((choice) => <label className="lg-surface lg-choice" data-glass="chip" key={choice.value}><input checked={appearance.material === choice.value} name="prefs-material" onChange={() => appearance.setMaterial(choice.value)} type="radio" value={choice.value} /><span>{choice.label}</span></label>)}</fieldset><GlassIntensity disabled={busy || !glassCapability.enabled}/><p className="prefs-note">液态玻璃由本应用绘制；实色会关闭透明效果。</p>{glassCapability.mode === 'frosted' ? <p className="prefs-note" role="status">当前浏览器以半透明材质显示。</p> : null}{glassCapability.mode === 'solid' && glassCapability.reason !== 'user-preference' ? <p className="prefs-note" role="status">{glassCapability.reason === 'increased-contrast' ? '当前系统要求更高对比度，界面使用实色材质。' : '当前浏览器不支持此光学方案，界面使用实色材质。'}</p> : null}</PreferenceGroup>
        <PreferenceGroup title="工作台壁纸"><PreferenceField label="壁纸路径" hint="可选择图片，或填写服务可读取的地址。" wide><input onChange={(event) => field('wallpaperPath', event.target.value)} spellCheck={false} value={draft.wallpaperPath || ''} /></PreferenceField><div className="prefs-wallpaper-actions"><GlassButton className="prefs-button" disabled={busy} onClick={() => void pick('wallpaper')} type="button"><Icon name="file" size={15} />{picker === 'wallpaper' ? '选择中…' : '选择图片'}</GlassButton><button className="prefs-text-button" disabled={!draft.wallpaperPath} onClick={() => field('wallpaperPath', '')} type="button">恢复默认背景</button></div>{toCssFileUrl(draft.wallpaperPath) ? <div aria-label="壁纸预览" className="prefs-wallpaper-preview" role="img" style={{ backgroundImage: `url(${JSON.stringify(toCssFileUrl(draft.wallpaperPath))})` }} /> : null}</PreferenceGroup>
      </>;
      case 'system': return <>
        <PreferenceGroup title="诊断记录"><PreferenceToggle label="调试模式" hint="记录更完整的任务诊断信息。" checked={draft.debugMode} onChange={(value) => field('debugMode', value)} /><PreferenceField label="日志级别"><GlassSelect label="日志级别" disabled={busy} onChange={(value) => field('logLevel', value as SaveSettingsPayload['logLevel'])} value={draft.logLevel} options={[{ value: 'debug', label: 'Debug' }, { value: 'info', label: 'Info' }, { value: 'warning', label: 'Warning' }, { value: 'error', label: 'Error' }]} /></PreferenceField></PreferenceGroup>
        <PreferenceGroup title="运行环境" description={`检查于 ${formatDateTime(workspace.snapshot?.environment.checkedAt)}`}><div className="prefs-environment-actions"><GlassButton className="prefs-button" onClick={() => void workspace.reload().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '无法刷新状态。'))} type="button"><Icon name="retry" size={15} />刷新状态</GlassButton></div>{workspace.snapshot?.environment.items.length ? <div className="prefs-environment">{workspace.snapshot.environment.items.map((item) => <article key={item.key}><header><Icon name={item.ok ? 'check' : 'warning'} size={16} /><strong>{item.label}</strong><small className={item.ok ? 'prefs-ready' : 'prefs-danger'}>{item.ok ? '可用' : '需处理'}</small></header><p>{normalizeUiText(item.details)}</p>{item.suggestion ? <small>{normalizeUiText(item.suggestion)}</small> : null}</article>)}</div> : <p className="prefs-note">尚未收到环境检查结果。</p>}</PreferenceGroup>
      </>;
    }
  };

  return <div className="prefs-backdrop" data-entry={entryMotion} onPointerDown={(event) => { if (event.currentTarget === event.target) requestClose(); }}>
    <GlassSurface aria-busy={busy} aria-describedby="prefs-description" aria-labelledby="prefs-title" aria-modal="true" className="prefs-dialog" ref={panelRef} role="dialog" tabIndex={-1}>
      <header className="prefs-header"><div><small>WHISPER STUDIO</small><h2 id="prefs-title">设置</h2><p id="prefs-description">让工作台适合你的工作方式。</p></div><GlassButton aria-label="关闭设置" className="prefs-close" onClick={requestClose} type="button"><Icon name="close" size={19} /></GlassButton></header>
      <nav aria-label="设置分区" className="prefs-tabs" ref={tabsRef} role="tablist">{categories.map((item, index) => <button aria-controls={`prefs-panel-${item.id}`} aria-selected={category === item.id} className="lg-surface lg-button prefs-tab" data-glass="button" data-lg-drag="press" id={`prefs-tab-${item.id}`} key={item.id} onClick={() => chooseCategory(item.id)} onKeyDown={(event) => navigateCategories(event, index)} ref={category === item.id ? firstTabRef : undefined} role="tab" tabIndex={category === item.id ? 0 : -1} type="button">{item.label}</button>)}</nav>
      <div className="prefs-scroll" ref={scrollRef}><section aria-labelledby={`prefs-tab-${displayedCategory}`} className="lens-content-transition prefs-page" id={`prefs-panel-${displayedCategory}`} ref={categoryContent.contentRef} role="tabpanel"><header className="prefs-page-heading"><h3>{currentCategory.label}</h3><p>{currentCategory.description}</p></header><fieldset className="prefs-editing" disabled={busy}>{renderCategory()}</fieldset></section></div>
      <footer className="prefs-footer">
        <div aria-live="polite" className="prefs-save-status">{error ? <span className="prefs-error" role="alert">{error}</span> : <span>{saving ? '正在保存，可以先关闭' : saved && !dirty ? '设置已保存' : dirty ? '有尚未应用的更改' : '当前设置已生效'}</span>}<small>外观立即生效；未应用内容暂留在此页面，关闭后可继续编辑。</small></div>
        <div className="prefs-footer-actions"><button className="prefs-text-button" disabled={busy || !dirty} onClick={reset} type="button">撤销更改</button><GlassButton className="prefs-button" onClick={requestClose} type="button">关闭</GlassButton><GlassButton className="prefs-button prefs-button-primary" disabled={busy || !dirty} onClick={() => void save()} type="button">{saving ? '保存中…' : '保存设置'}</GlassButton></div>
      </footer>
    </GlassSurface>
  </div>;
}

function PreferencesSessionController(props: PreferencesProps & { settings: SettingsData }): React.JSX.Element | null {
  const session = usePreferencesSession(props.settings, props.workspace.saveSettings);
  return props.open ? <PreferencesDialog {...props} session={session} /> : null;
}

export default function Preferences(props: PreferencesProps): React.JSX.Element | null {
  return props.workspace.snapshot ? <PreferencesSessionController {...props} settings={props.workspace.snapshot.settings} /> : null;
}
