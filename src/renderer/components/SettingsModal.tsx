import { motion } from 'framer-motion';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import {
  FASTER_WHISPER_MODEL_OPTIONS,
  DEFAULT_TRANSLATION_MAX_GROUP_LENGTH,
  DEFAULT_TRANSLATION_MAX_TEXT_LENGTH,
  DEFAULT_TRANSLATION_REQUEST_LIMIT,
  DEFAULT_TRANSLATION_TEMPERATURE,
  OPENAI_WHISPER_MODEL_OPTIONS,
  WHISPER_CPP_MODEL_OPTIONS
} from '../../shared/constants';
import type {
  SaveSettingsPayload,
  SettingsData,
  TranscriptionEngine,
  TranslationServiceInput
} from '../../shared/types';
import {
  modalBackdropVariants,
  modalPanelVariants,
  paneSwitchVariants
} from '../motion';
import { toCssFileUrl } from '../utils';
import Icon, { type IconName } from './Icon';

interface SettingsModalProps {
  settings: SettingsData;
  onClose: () => void;
  onSave: (payload: SaveSettingsPayload) => Promise<void>;
  onPickDirectory: () => Promise<string | null>;
  onPickWallpaper: () => Promise<string | null>;
}

type SettingsTab = 'general' | 'translation' | 'advanced';

interface SettingsTabDefinition {
  id: SettingsTab;
  label: string;
  description: string;
  eyebrow: string;
  title: string;
  icon: IconName;
}

interface TranslationTestFeedback {
  serviceId: string;
  tone: 'testing' | 'success' | 'error';
  title: string;
  details?: string;
}

const settingsTabs: SettingsTabDefinition[] = [
  {
    id: 'general',
    label: '基础',
    description: '转写引擎与文件',
    eyebrow: '工作流',
    title: '基础设置',
    icon: 'model'
  },
  {
    id: 'translation',
    label: '翻译',
    description: '自定义服务列表',
    eyebrow: '语言服务',
    title: '翻译设置',
    icon: 'translate'
  },
  {
    id: 'advanced',
    label: '外观与高级',
    description: '壁纸、日志与调试',
    eyebrow: '个性化',
    title: '外观与高级',
    icon: 'palette'
  }
];

const transcriptionEngineOptions: Array<{ value: TranscriptionEngine; label: string }> = [
  { value: 'faster-whisper', label: 'faster-whisper' },
  { value: 'whisper.cpp', label: 'whisper.cpp（Vulkan / CPU）' },
  { value: 'whisper', label: 'openai-whisper' }
];

const transcriptionModelsByEngine: Record<TranscriptionEngine, readonly string[]> = {
  whisper: OPENAI_WHISPER_MODEL_OPTIONS,
  'faster-whisper': FASTER_WHISPER_MODEL_OPTIONS,
  'whisper.cpp': WHISPER_CPP_MODEL_OPTIONS
};

function getDefaultModelForEngine(engine: TranscriptionEngine): string {
  const models = transcriptionModelsByEngine[engine];
  return models.includes('turbo') ? 'turbo' : models[0];
}

function normalizeModelForEngine(engine: TranscriptionEngine, model: string): string {
  return transcriptionModelsByEngine[engine].includes(model)
    ? model
    : getDefaultModelForEngine(engine);
}

function getModelOptionsForEngine(engine: TranscriptionEngine): string[] {
  return [...transcriptionModelsByEngine[engine]];
}

function createFormFromSettings(settings: SettingsData): SaveSettingsPayload {
  return {
    maxConcurrentDownloads: settings.maxConcurrentDownloads ?? 3,
    maxConcurrentTranscriptions: settings.maxConcurrentTranscriptions ?? 1,
    maxConcurrentTranslations: settings.maxConcurrentTranslations ?? 2,
    downloadConnections: settings.downloadConnections ?? 8,
    youtubeCookieSource: settings.youtubeCookieSource ?? 'auto',
    youtubeBrowserProfile: settings.youtubeBrowserProfile ?? '',
    pythonPath: settings.pythonPath,
    outputDir: settings.outputDir,
    whisperModel: normalizeModelForEngine(settings.transcriptionEngine, settings.whisperModel),
    transcriptionEngine: settings.transcriptionEngine,
    wallpaperPath: settings.wallpaperPath,
    translateByDefault: settings.translateByDefault,
    translationServices: settings.translationServices.map((service) => {
      const { apiKeyConfigured: _apiKeyConfigured, apiKeySource: _apiKeySource, ...persisted } = service;
      return { ...persisted, apiKey: '', clearApiKey: false };
    }),
    activeTranslationServiceId: settings.activeTranslationServiceId,
    keepAudio: settings.keepAudio,
    logLevel: settings.logLevel,
    debugMode: settings.debugMode
  };
}

const createEmptyTranslationService = (): TranslationServiceInput => ({
  id: crypto.randomUUID().replace(/-/g, ''),
  name: '自定义翻译服务',
  enabled: true,
  apiUrl: '',
  model: '',
  customContent: '',
  enableAiContext: false,
  systemPrompt: '',
  multiplePrompt: '',
  prompt: '',
  requestLimit: DEFAULT_TRANSLATION_REQUEST_LIMIT,
  maxTextLengthPerRequest: DEFAULT_TRANSLATION_MAX_TEXT_LENGTH,
  maxTextGroupLengthPerRequest: DEFAULT_TRANSLATION_MAX_GROUP_LENGTH,
  enableRichTranslate: false,
  maxTextGroupLengthPerRequestForSubtitle: DEFAULT_TRANSLATION_MAX_GROUP_LENGTH,
  subtitlePrompt: '',
  temperature: DEFAULT_TRANSLATION_TEMPERATURE,
  apiKey: '',
  clearApiKey: false
});

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

function SettingsModal({
  settings,
  onClose,
  onSave,
  onPickDirectory,
  onPickWallpaper
}: SettingsModalProps): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [form, setForm] = useState<SaveSettingsPayload>(() => createFormFromSettings(settings));
  const [selectedServiceId, setSelectedServiceId] = useState<string | undefined>(
    settings.activeTranslationServiceId || settings.translationServices[0]?.id
  );
  const [saving, setSaving] = useState(false);
  const [pendingPicker, setPendingPicker] = useState<'output-directory' | 'wallpaper' | null>(null);
  const [operationError, setOperationError] = useState('');
  const [translationTestFeedback, setTranslationTestFeedback] = useState<TranslationTestFeedback>();
  const translationTestRequestId = useRef(0);
  const translationSettingsSignature = JSON.stringify({
    services: settings.translationServices,
    activeId: settings.activeTranslationServiceId
  });

  useEffect(() => {
    translationTestRequestId.current += 1;
    setForm(createFormFromSettings(settings));
    setOperationError('');
    setTranslationTestFeedback(undefined);
    setSelectedServiceId(settings.activeTranslationServiceId || settings.translationServices[0]?.id);
  }, [
    settings.maxConcurrentDownloads,
    settings.maxConcurrentTranscriptions,
    settings.maxConcurrentTranslations,
    settings.downloadConnections,
    settings.youtubeCookieSource,
    settings.youtubeBrowserProfile,
    settings.pythonPath,
    settings.outputDir,
    settings.whisperModel,
    settings.transcriptionEngine,
    settings.wallpaperPath,
    settings.translateByDefault,
    settings.activeTranslationServiceId,
    translationSettingsSignature,
    settings.keepAudio,
    settings.logLevel,
    settings.debugMode
  ]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose, saving]);

  const updateField = <K extends keyof SaveSettingsPayload>(
    key: K,
    value: SaveSettingsPayload[K]
  ): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  function reportOperationError(action: string, error: unknown, fallback: string): string {
    const message = getErrorMessage(error, fallback);
    console.error(action, error);
    setOperationError(`${action}：${message}`);
    return message;
  }

  const handleTranscriptionEngineChange = (engine: TranscriptionEngine): void => {
    setForm((current) => ({
      ...current,
      transcriptionEngine: engine,
      whisperModel: normalizeModelForEngine(engine, current.whisperModel)
    }));
  };

  const updateTranslationService = (
    serviceId: string,
    patch: Partial<TranslationServiceInput>
  ): void => {
    translationTestRequestId.current += 1;
    setTranslationTestFeedback((current) => current?.serviceId === serviceId ? undefined : current);
    setForm((current) => ({
      ...current,
      translationServices: current.translationServices.map((service) =>
        service.id === serviceId ? { ...service, ...patch } : service
      )
    }));
  };

  const handleAddTranslationService = (): void => {
    const service = createEmptyTranslationService();
    setForm((current) => ({
      ...current,
      translationServices: [...current.translationServices, service],
      activeTranslationServiceId: current.activeTranslationServiceId || service.id
    }));
    setSelectedServiceId(service.id);
    setOperationError('');
  };

  const handleToggleTranslationService = (serviceId: string, enabled: boolean): void => {
    setForm((current) => {
      const services = current.translationServices.map((service) =>
        service.id === serviceId ? { ...service, enabled } : service
      );
      const activeTranslationServiceId =
        current.activeTranslationServiceId === serviceId && !enabled
          ? services.find((service) => service.enabled)?.id
          : current.activeTranslationServiceId || services.find((service) => service.enabled)?.id;
      return { ...current, translationServices: services, activeTranslationServiceId };
    });
  };

  const handleSetDefaultTranslationService = (serviceId: string): void => {
    setForm((current) => ({ ...current, activeTranslationServiceId: serviceId }));
    setSelectedServiceId(serviceId);
  };

  const handleDeleteTranslationService = (serviceId: string): void => {
    translationTestRequestId.current += 1;
    setTranslationTestFeedback((current) => current?.serviceId === serviceId ? undefined : current);
    setForm((current) => {
      const services = current.translationServices.filter((service) => service.id !== serviceId);
      const activeTranslationServiceId = current.activeTranslationServiceId === serviceId
        ? services.find((service) => service.enabled)?.id
        : current.activeTranslationServiceId;
      return { ...current, translationServices: services, activeTranslationServiceId };
    });
    setSelectedServiceId((current) => current === serviceId
      ? form.translationServices.find((service) => service.id !== serviceId)?.id
      : current);
  };

  const handleTestTranslationService = async (service: TranslationServiceInput): Promise<void> => {
    if (!service.apiUrl.trim() || !service.model.trim()) {
      setTranslationTestFeedback({
        serviceId: service.id,
        tone: 'error',
        title: '请先填写接口地址和模型名称。'
      });
      return;
    }

    const requestId = ++translationTestRequestId.current;
    setTranslationTestFeedback({
      serviceId: service.id,
      tone: 'testing',
      title: '正在发送测试翻译…',
      details: '将自动探测 Responses 与 Chat Completions 兼容模式。'
    });

    try {
      const result = await window.whisperWeb.testTranslationService(service);
      if (translationTestRequestId.current !== requestId) {
        return;
      }
      const modeLabel = result.mode === 'responses' ? 'Responses API' : 'Chat Completions';
      setTranslationTestFeedback({
        serviceId: service.id,
        tone: 'success',
        title: `测试成功 · ${result.latencyMs} ms`,
        details: `${modeLabel} · ${result.endpoint} · 返回：${result.responsePreview}`
      });
    } catch (error) {
      if (translationTestRequestId.current !== requestId) {
        return;
      }
      setTranslationTestFeedback({
        serviceId: service.id,
        tone: 'error',
        title: '测试失败',
        details: getErrorMessage(error, '接口没有返回可用的翻译结果。')
      });
    }
  };

  const handleSave = async (): Promise<void> => {
    if (saving) {
      return;
    }

    setSaving(true);
    setOperationError('');

    try {
      await onSave(form);
      onClose();
    } catch (error) {
      reportOperationError('保存设置失败', error, '请检查设置内容并稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const handlePickOutputDirectory = async (): Promise<void> => {
    if (pendingPicker !== null) {
      return;
    }

    setPendingPicker('output-directory');
    setOperationError('');

    try {
      const chosen = await onPickDirectory();
      if (chosen) {
        updateField('outputDir', chosen);
      }
    } catch (error) {
      reportOperationError('选择输出目录失败', error, '无法打开目录选择器');
    } finally {
      setPendingPicker(null);
    }
  };

  const handlePickWallpaper = async (): Promise<void> => {
    if (pendingPicker !== null) {
      return;
    }

    setPendingPicker('wallpaper');
    setOperationError('');

    try {
      const chosen = await onPickWallpaper();
      if (chosen) {
        updateField('wallpaperPath', chosen);
      }
    } catch (error) {
      reportOperationError('选择壁纸失败', error, '无法打开图片选择器');
    } finally {
      setPendingPicker(null);
    }
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ): void => {
    let nextIndex: number | null = null;

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % settingsTabs.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + settingsTabs.length) % settingsTabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = settingsTabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTab = settingsTabs[nextIndex];
    setTab(nextTab.id);
    document.getElementById(`settings-tab-${nextTab.id}`)?.focus();
  };

  const activeTab = settingsTabs.find((item) => item.id === tab) ?? settingsTabs[0];
  const wallpaperPreviewUrl = toCssFileUrl(form.wallpaperPath);
  const transcriptionModelOptions = getModelOptionsForEngine(form.transcriptionEngine);
  const selectedService = form.translationServices.find((service) => service.id === selectedServiceId);
  const storedSelectedService = settings.translationServices.find((service) => service.id === selectedServiceId);
  const selectedTestFeedback = translationTestFeedback?.serviceId === selectedServiceId
    ? translationTestFeedback
    : undefined;
  const testingTranslationService = selectedTestFeedback?.tone === 'testing';
  const pickingOutputDirectory = pendingPicker === 'output-directory';
  const pickingWallpaper = pendingPicker === 'wallpaper';
  const pickerBusy = pendingPicker !== null;

  const renderGeneralSettings = (): React.JSX.Element => (
    <div className="settings-section-stack">
      <section className="settings-group">
        <div className="settings-group-heading">
          <span className="settings-group-icon">
            <Icon name="model" size={18} />
          </span>
          <div>
            <h4>转写引擎</h4>
            <p>选择 WebUI 服务使用的 Python 环境、引擎与模型。</p>
          </div>
        </div>

        <div className="settings-grid">
          <label className="settings-field settings-field-wide">
            <span>Python 路径</span>
            <input
              onChange={(event) => updateField('pythonPath', event.target.value)}
              spellCheck={false}
              type="text"
              value={form.pythonPath}
            />
          </label>

          <label className="settings-field">
            <span>转写引擎</span>
            <select
              onChange={(event) => handleTranscriptionEngineChange(event.target.value as TranscriptionEngine)}
              value={form.transcriptionEngine}
            >
              {transcriptionEngineOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {form.transcriptionEngine === 'whisper.cpp' && (
              <small>使用原生 GGML 模型。GPU 加速取决于系统、显卡驱动和安装的后端；无法使用时可回退 CPU。</small>
            )}
          </label>

          <label className="settings-field">
            <span>Whisper 模型</span>
            <select
              onChange={(event) => updateField('whisperModel', event.target.value)}
              value={form.whisperModel}
            >
              {transcriptionModelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            {form.transcriptionEngine === 'whisper.cpp' && (
              <small>首次启动自动准备所选模型。更换为尚未下载的模型后，保存设置并重新启动以下载。</small>
            )}
          </label>
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group-heading">
          <span className="settings-group-icon">
            <Icon name="sparkles" size={18} />
          </span>
          <div>
            <h4>多任务与下载速度</h4>
            <p>下载、转写和翻译可同时进行，分别设置每类任务的同时处理数量。</p>
          </div>
        </div>

        <div className="settings-grid">
          <label className="settings-field">
            <span>同时下载任务数</span>
            <select
              value={form.maxConcurrentDownloads ?? 3}
              onChange={(event) => updateField('maxConcurrentDownloads', Number(event.target.value))}
            >
              {Array.from({ length: 6 }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>{count} 个{count === 3 ? '（推荐）' : ''}</option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>每个下载的连接数</span>
            <select
              value={form.downloadConnections ?? 8}
              onChange={(event) => updateField('downloadConnections', Number(event.target.value))}
            >
              {Array.from({ length: 16 }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>{count} 个{count === 8 ? '（推荐）' : ''}</option>
              ))}
            </select>
            <small>在网站支持时分段并行下载；实际速度也受网络和网站限制。</small>
          </label>

          <label className="settings-field">
            <span>同时转写任务数</span>
            <select
              value={form.maxConcurrentTranscriptions ?? 1}
              onChange={(event) => updateField('maxConcurrentTranscriptions', Number(event.target.value))}
            >
              <option value={1}>1 个（推荐）</option>
              <option value={2}>2 个</option>
            </select>
            <small>转写默认集中使用显卡处理一个任务，避免重复加载模型占用显存。</small>
          </label>

          <label className="settings-field">
            <span>同时翻译任务数</span>
            <select
              value={form.maxConcurrentTranslations ?? 2}
              onChange={(event) => updateField('maxConcurrentTranslations', Number(event.target.value))}
            >
              {Array.from({ length: 4 }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>{count} 个{count === 2 ? '（推荐）' : ''}</option>
              ))}
            </select>
            <small>翻译服务的请求频率限制仍然有效。</small>
          </label>
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group-heading">
          <span className="settings-group-icon">
            <Icon name="folder" size={18} />
          </span>
          <div>
            <h4>文件与默认行为</h4>
            <p>控制输出位置，以及新任务创建时采用的默认选项。</p>
          </div>
        </div>

        <div className="settings-grid">
          <label className="settings-field settings-field-wide">
            <span>输出目录</span>
            <div className="inline-picker">
              <input
                onChange={(event) => updateField('outputDir', event.target.value)}
                spellCheck={false}
                type="text"
                value={form.outputDir}
              />
              <button
                className="ghost-button"
                disabled={pickerBusy || saving}
                onClick={() => void handlePickOutputDirectory()}
                type="button"
              >
                <Icon name="folder" size={15} />
                {pickingOutputDirectory ? '正在选择…' : '选择'}
              </button>
            </div>
          </label>

          <label className="settings-field settings-field-wide">
            <span>YouTube 登录来源</span>
            <select value={form.youtubeCookieSource ?? 'auto'} onChange={(event) => updateField('youtubeCookieSource', event.target.value as SaveSettingsPayload['youtubeCookieSource'])}>
              <option value="auto">自动选择（优先 Firefox）</option>
              <option value="firefox">Firefox 登录账号</option>
              <option value="chrome">Chrome 登录账号</option>
              <option value="file">项目目录中的 cookies.txt</option>
              <option value="none">不使用登录状态</option>
            </select>
            <small>会员视频使用浏览器中已登录账号的权限。建议使用 Firefox；登录信息仅在本机内存中使用。</small>
          </label>
          {(form.youtubeCookieSource === 'firefox' || form.youtubeCookieSource === 'chrome') && (
            <label className="settings-field settings-field-wide">
              <span>浏览器配置目录（可选）</span>
              <input value={form.youtubeBrowserProfile ?? ''} placeholder="留空自动查找；多账号时可指定对应配置目录" onChange={(event) => updateField('youtubeBrowserProfile', event.target.value)} />
            </label>
          )}

          <label className="settings-toggle-card">
            <input
              checked={form.translateByDefault}
              onChange={(event) => updateField('translateByDefault', event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>默认翻译成中文</strong>
              <small>新任务自动进入翻译流程</small>
            </span>
          </label>

          <label className="settings-toggle-card">
            <input
              checked={form.keepAudio}
              onChange={(event) => updateField('keepAudio', event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>保留下载音频</strong>
              <small>任务完成后不清理源音频</small>
            </span>
          </label>
        </div>
      </section>
    </div>
  );

  const renderTranslationSettings = (): React.JSX.Element => (
    <div className="settings-section-stack">
      <section className="settings-group">
        <div className="settings-group-heading translation-service-list-heading">
          <span className="settings-group-icon">
            <Icon name="translate" size={18} />
          </span>
          <div>
            <h4>翻译服务列表</h4>
            <p>所有服务均由你自行配置；免费接口可以不填写 API Key。</p>
          </div>
          <button
            className="ghost-button translation-service-add"
            disabled={saving}
            onClick={handleAddTranslationService}
            type="button"
          >
            <Icon name="sparkles" size={15} />
            添加自定义翻译服务
          </button>
        </div>

        {form.translationServices.length > 0 ? (
          <div className="translation-service-list" role="list">
            {form.translationServices.map((service) => {
              const isDefault = service.id === form.activeTranslationServiceId;
              const isSelected = service.id === selectedServiceId;
              return (
                <article
                  className={`translation-service-item ${isSelected ? 'selected' : ''}`}
                  key={service.id}
                  role="listitem"
                >
                  <label className="translation-service-switch">
                    <input
                      aria-label={`${service.name}启用状态`}
                      checked={service.enabled}
                      onChange={(event) => handleToggleTranslationService(service.id, event.target.checked)}
                      role="switch"
                      type="checkbox"
                    />
                  </label>
                  <button
                    aria-pressed={isSelected}
                    className="translation-service-main"
                    onClick={() => setSelectedServiceId(service.id)}
                    type="button"
                  >
                    <span className="translation-service-avatar">
                      <Icon name="translate" size={17} />
                    </span>
                    <span className="translation-service-copy">
                      <strong>{service.name}</strong>
                      <small>{service.model || '未填写模型'} · {service.apiUrl || '未填写接口地址'}</small>
                    </span>
                  </button>
                  {isDefault ? (
                    <span className="translation-service-default-badge">
                      <Icon name="check" size={12} />默认
                    </span>
                  ) : (
                    <button
                      className="translation-service-default-action"
                      disabled={!service.enabled}
                      onClick={() => handleSetDefaultTranslationService(service.id)}
                      type="button"
                    >
                      设为默认
                    </button>
                  )}
                  <button
                    aria-label={`编辑${service.name}`}
                    className="icon-button translation-service-action"
                    onClick={() => setSelectedServiceId(service.id)}
                    type="button"
                  >
                    <Icon name="settings" size={15} />
                  </button>
                  <button
                    aria-label={`删除${service.name}`}
                    className="icon-button translation-service-action danger"
                    onClick={() => handleDeleteTranslationService(service.id)}
                    type="button"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="translation-service-empty">
            <Icon name="translate" size={24} />
            <strong>还没有翻译服务</strong>
            <p>添加免费的匿名接口，或填写你自己的兼容接口。</p>
            <button className="ghost-button" onClick={handleAddTranslationService} type="button">
              添加第一个服务
            </button>
          </div>
        )}
      </section>

      {selectedService ? (
        <section className="settings-group translation-service-editor">
          <div className="settings-group-heading settings-provider-heading">
            <span className="settings-group-icon">
              <Icon name="settings" size={18} />
            </span>
            <div>
              <h4>服务配置</h4>
              <p>配置内容仅保存在运行 WebUI 的这台设备上。</p>
            </div>
            <button
              className="ghost-button translation-service-test-button"
              disabled={saving || testingTranslationService}
              onClick={() => void handleTestTranslationService(selectedService)}
              type="button"
            >
              <Icon name={testingTranslationService ? 'clock' : 'retry'} size={15} />
              {testingTranslationService ? '正在测试…' : '测试服务'}
            </button>
          </div>

          {selectedTestFeedback ? (
            <div
              aria-live="polite"
              className={`translation-service-test-result ${selectedTestFeedback.tone}`}
              role="status"
            >
              <Icon
                name={selectedTestFeedback.tone === 'success'
                  ? 'check'
                  : selectedTestFeedback.tone === 'error'
                    ? 'warning'
                    : 'clock'}
                size={15}
              />
              <span>
                <strong>{selectedTestFeedback.title}</strong>
                {selectedTestFeedback.details ? <small>{selectedTestFeedback.details}</small> : null}
              </span>
            </div>
          ) : null}

          <div className="settings-grid">
            <label className="settings-field">
              <span>自定义翻译服务名称</span>
              <input
                onChange={(event) => updateTranslationService(selectedService.id, { name: event.target.value })}
                placeholder="翻译服务名称"
                value={selectedService.name}
              />
            </label>
            <label className="settings-field">
              <span>模型</span>
              <input
                onChange={(event) => updateTranslationService(selectedService.id, { model: event.target.value })}
                placeholder="模型名称"
                spellCheck={false}
                value={selectedService.model}
              />
            </label>
            <label className="settings-field settings-field-wide">
              <span>自定义 API 接口地址</span>
              <input
                onChange={(event) => updateTranslationService(selectedService.id, { apiUrl: event.target.value })}
                placeholder="https://example.com/v1"
                spellCheck={false}
                type="url"
                value={selectedService.apiUrl}
              />
              <small className="inline-status">兼容 Responses 或 Chat Completions 的接口均可。</small>
            </label>
            <label className="settings-field settings-field-wide">
              <span>APIKEY（可选）</span>
              <input
                autoComplete="off"
                onChange={(event) => updateTranslationService(selectedService.id, {
                  apiKey: event.target.value,
                  clearApiKey: false
                })}
                placeholder="免费或匿名接口可留空"
                type="password"
                value={selectedService.apiKey || ''}
              />
              <small className="inline-status">
                {selectedService.apiKey
                  ? '保存后将更新本地加密密钥'
                  : storedSelectedService?.apiKeyConfigured && !selectedService.clearApiKey
                    ? '已在本机加密保存'
                    : '当前未配置密钥'}
              </small>
            </label>

            {storedSelectedService?.apiKeyConfigured ? (
              <label className="settings-toggle-card settings-field-wide settings-danger-toggle">
                <input
                  checked={Boolean(selectedService.clearApiKey)}
                  onChange={(event) => updateTranslationService(selectedService.id, {
                    clearApiKey: event.target.checked,
                    apiKey: event.target.checked ? '' : selectedService.apiKey
                  })}
                  type="checkbox"
                />
                <span>
                  <strong>清除该服务的 API Key</strong>
                  <small>保存后只删除当前服务的本地密钥</small>
                </span>
              </label>
            ) : null}

            <label className="settings-field settings-field-wide">
              <span>你可以指定 AI 专家来提供翻译策略</span>
              <textarea
                onChange={(event) => updateTranslationService(selectedService.id, { customContent: event.target.value })}
                placeholder="例如：熟悉影视字幕、技术术语或特定人物语气"
                rows={3}
                value={selectedService.customContent}
              />
            </label>

            <label className="settings-toggle-card">
              <input
                checked={selectedService.enableAiContext}
                onChange={(event) => updateTranslationService(selectedService.id, { enableAiContext: event.target.checked })}
                type="checkbox"
              />
              <span>
                <strong>启用 AI 智能上下文</strong>
                <small>利用相邻字幕辅助理解</small>
              </span>
            </label>
            <label className="settings-toggle-card">
              <input
                checked={selectedService.enableRichTranslate}
                onChange={(event) => updateTranslationService(selectedService.id, { enableRichTranslate: event.target.checked })}
                type="checkbox"
              />
              <span>
                <strong>启用富文本翻译</strong>
                <small>尽量保留链接与轻量标记</small>
              </span>
            </label>
          </div>

          <details className="translation-service-advanced">
            <summary>高级翻译参数</summary>
            <div className="settings-grid">
              <label className="settings-field settings-field-wide">
                <span>系统提示词</span>
                <textarea
                  onChange={(event) => updateTranslationService(selectedService.id, { systemPrompt: event.target.value })}
                  placeholder="留空时使用内置字幕翻译规则"
                  rows={4}
                  value={selectedService.systemPrompt}
                />
              </label>
              <label className="settings-field settings-field-wide">
                <span>多段提示词</span>
                <textarea
                  onChange={(event) => updateTranslationService(selectedService.id, { multiplePrompt: event.target.value })}
                  placeholder="multiplePrompt"
                  rows={3}
                  value={selectedService.multiplePrompt}
                />
              </label>
              <label className="settings-field settings-field-wide">
                <span>单段提示词</span>
                <textarea
                  onChange={(event) => updateTranslationService(selectedService.id, { prompt: event.target.value })}
                  placeholder="prompt"
                  rows={3}
                  value={selectedService.prompt}
                />
              </label>
              <label className="settings-field">
                <span>每秒最大请求数</span>
                <input
                  min="0.1"
                  onChange={(event) => updateTranslationService(selectedService.id, { requestLimit: Number(event.target.value) })}
                  step="0.1"
                  type="number"
                  value={selectedService.requestLimit}
                />
              </label>
              <label className="settings-field">
                <span>每次请求最大文本长度</span>
                <input
                  min="100"
                  onChange={(event) => updateTranslationService(selectedService.id, { maxTextLengthPerRequest: Number(event.target.value) })}
                  type="number"
                  value={selectedService.maxTextLengthPerRequest}
                />
              </label>
              <label className="settings-field">
                <span>每次请求最大段落数</span>
                <input
                  min="1"
                  onChange={(event) => updateTranslationService(selectedService.id, { maxTextGroupLengthPerRequest: Number(event.target.value) })}
                  type="number"
                  value={selectedService.maxTextGroupLengthPerRequest}
                />
              </label>
              <label className="settings-field">
                <span>每次字幕请求最大段落数</span>
                <input
                  min="1"
                  onChange={(event) => updateTranslationService(selectedService.id, {
                    maxTextGroupLengthPerRequestForSubtitle: Number(event.target.value)
                  })}
                  type="number"
                  value={selectedService.maxTextGroupLengthPerRequestForSubtitle}
                />
              </label>
              <label className="settings-field settings-field-wide">
                <span>Subtitle Prompt</span>
                <textarea
                  onChange={(event) => updateTranslationService(selectedService.id, { subtitlePrompt: event.target.value })}
                  placeholder="subtitlePrompt"
                  rows={4}
                  value={selectedService.subtitlePrompt}
                />
              </label>
              <label className="settings-field">
                <span>Temperature</span>
                <input
                  max="2"
                  min="0"
                  onChange={(event) => updateTranslationService(selectedService.id, { temperature: Number(event.target.value) })}
                  step="0.1"
                  type="number"
                  value={selectedService.temperature}
                />
              </label>
            </div>
          </details>
        </section>
      ) : null}
    </div>
  );

  const renderAdvancedSettings = (): React.JSX.Element => (
    <div className="settings-section-stack">
      <section className="settings-group">
        <div className="settings-group-heading">
          <span className="settings-group-icon">
            <Icon name="palette" size={18} />
          </span>
          <div>
            <h4>工作台壁纸</h4>
            <p>选择一张图片，让液态玻璃界面拥有属于你的光影。</p>
          </div>
        </div>

        <div className="settings-grid">
          <div className="settings-field settings-field-wide">
            <span>自定义壁纸</span>
            <div className="inline-picker">
              <input
                onChange={(event) => updateField('wallpaperPath', event.target.value)}
                placeholder="未设置时使用默认玻璃背景"
                spellCheck={false}
                type="text"
                value={form.wallpaperPath || ''}
              />
              <button
                className="ghost-button"
                disabled={pickerBusy || saving}
                onClick={() => void handlePickWallpaper()}
                type="button"
              >
                <Icon name="file" size={15} />
                {pickingWallpaper ? '正在选择…' : '选择图片'}
              </button>
              <button
                className="ghost-button"
                disabled={!form.wallpaperPath || pickerBusy || saving}
                onClick={() => updateField('wallpaperPath', '')}
                type="button"
              >
                <Icon name="trash" size={15} />
                清除
              </button>
            </div>
            <small className="inline-status">支持 PNG、JPG、WEBP、BMP、GIF、AVIF。</small>
          </div>

          {wallpaperPreviewUrl ? (
            <div className="settings-field settings-field-wide">
              <span>壁纸预览</span>
              <div className="wallpaper-preview-card">
                <div
                  aria-label="当前壁纸预览"
                  className="wallpaper-preview-image"
                  role="img"
                  style={{ backgroundImage: `url("${wallpaperPreviewUrl}")` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group-heading">
          <span className="settings-group-icon">
            <Icon name="terminal" size={18} />
          </span>
          <div>
            <h4>诊断与日志</h4>
            <p>出现问题时记录更多信息，便于定位转写流程中的异常。</p>
          </div>
        </div>

        <div className="settings-grid">
          <label className="settings-toggle-card">
            <input
              checked={form.debugMode}
              onChange={(event) => updateField('debugMode', event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>调试模式</strong>
              <small>保留更完整的诊断信息</small>
            </span>
          </label>

          <label className="settings-field">
            <span>日志级别</span>
            <select
              onChange={(event) => updateField('logLevel', event.target.value as SaveSettingsPayload['logLevel'])}
              value={form.logLevel}
            >
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warning">warning</option>
              <option value="error">error</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  );

  const renderActivePanel = (): React.JSX.Element => {
    switch (tab) {
      case 'translation':
        return renderTranslationSettings();
      case 'advanced':
        return renderAdvancedSettings();
      default:
        return renderGeneralSettings();
    }
  };

  return (
    <motion.div
      animate="visible"
      className="modal-backdrop settings-modal-backdrop"
      exit="exit"
      initial="hidden"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !saving) {
          onClose();
        }
      }}
      variants={modalBackdropVariants}
    >
      <motion.div
        aria-busy={saving || pickerBusy}
        aria-describedby="settings-modal-description"
        aria-labelledby="settings-modal-title"
        aria-modal="true"
        className="settings-dialog glass-float"
        role="dialog"
        variants={modalPanelVariants}
      >
        <header className="settings-modal-header">
          <div className="settings-modal-heading">
            <span className="settings-modal-mark">
              <Icon name="settings" size={21} />
            </span>
            <div>
              <p className="eyebrow">设置中心</p>
              <h2 id="settings-modal-title">Whisper Studio</h2>
              <p className="modal-subtitle" id="settings-modal-description">
                管理转写、翻译与工作台外观。
              </p>
            </div>
          </div>
          <button
            aria-label="关闭设置"
            className="modal-close-button"
            disabled={saving}
            onClick={onClose}
            type="button"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="settings-modal-shell">
          <aside className="settings-sidebar">
            <nav aria-label="设置分区" aria-orientation="vertical" className="settings-side-nav" role="tablist">
              {settingsTabs.map((item, index) => {
                const isActive = item.id === tab;

                return (
                  <button
                    aria-controls={`settings-panel-${item.id}`}
                    aria-selected={isActive}
                    className={`settings-side-nav-item ${isActive ? 'active' : ''}`}
                    data-active={isActive}
                    id={`settings-tab-${item.id}`}
                    key={item.id}
                    onClick={() => setTab(item.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                    role="tab"
                    tabIndex={isActive ? 0 : -1}
                    type="button"
                  >
                    <span className="settings-side-nav-icon">
                      <Icon name={item.icon} size={18} />
                    </span>
                    <span className="settings-side-nav-copy">
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="settings-sidebar-note">
              <Icon name="info" size={16} />
              <span>设置仅保存在此设备</span>
            </div>
          </aside>

          <div className="settings-main-column">
            <div className="settings-content-header">
              <div>
                <p className="eyebrow">{activeTab.eyebrow}</p>
                <h3>{activeTab.title}</h3>
              </div>
              <span className="settings-content-header-icon">
                <Icon name={activeTab.icon} size={20} />
              </span>
            </div>

            <div className="settings-content-viewport">
              <motion.section
                animate="active"
                aria-labelledby={`settings-tab-${tab}`}
                className="settings-pane"
                id={`settings-panel-${tab}`}
                initial="inactive"
                key={tab}
                role="tabpanel"
                variants={paneSwitchVariants}
              >
                <div className="settings-pane-content">{renderActivePanel()}</div>
              </motion.section>
            </div>

            <footer className="settings-modal-footer">
              <small
                aria-atomic="true"
                aria-live="assertive"
                className="inline-status settings-operation-error"
              >
                {operationError ? (
                  <>
                    <Icon name="warning" size={13} />
                    {operationError}
                  </>
                ) : null}
              </small>
              <button
                className="ghost-button"
                disabled={saving || pickerBusy}
                onClick={onClose}
                type="button"
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={saving || pickerBusy}
                onClick={() => void handleSave()}
                type="button"
              >
                {saving ? '正在保存…' : '保存设置'}
              </button>
            </footer>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default SettingsModal;
