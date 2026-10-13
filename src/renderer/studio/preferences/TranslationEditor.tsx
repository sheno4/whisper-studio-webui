import { useRef, useState } from 'react';

import type { SaveSettingsPayload, SettingsData, TranslationServiceInput } from '../../../shared/types';
import Icon from '../../components/Icon';
import { GlassButton } from '../../glass';
import { PreferenceField, PreferenceGroup, PreferenceToggle } from './Fields';
import { emptyTranslationService, MAX_TRANSLATION_SERVICES, serviceNumberFields } from './draft';

interface TranslationEditorProps {
  draft: SaveSettingsPayload;
  settings: SettingsData;
  selectedId?: string;
  select: (id: string | undefined) => void;
  update: (draft: SaveSettingsPayload) => void;
}

type PromptField = 'systemPrompt' | 'multiplePrompt' | 'prompt' | 'subtitlePrompt';
const promptFields: Array<{ key: PromptField; label: string; hint: string }> = [
  { key: 'systemPrompt', label: '系统提示词', hint: '留空使用内置字幕翻译规则。' },
  { key: 'multiplePrompt', label: '多段提示词', hint: '同时翻译多段文本时使用。' },
  { key: 'prompt', label: '单段提示词', hint: '翻译单段文本时使用。' },
  { key: 'subtitlePrompt', label: '字幕提示词', hint: '字幕翻译使用的额外规则。' }
];

export default function TranslationEditor({ draft, settings, selectedId, select, update }: TranslationEditorProps): React.JSX.Element {
  const [feedback, setFeedback] = useState<{ serviceId: string; tone: 'success' | 'error' | 'testing'; message: string; detail?: string }>();
  const testVersion = useRef(0);
  const activeTest = useRef<{ version: number; fingerprint: string; serviceId: string } | undefined>(undefined);
  const service = draft.translationServices.find((candidate) => candidate.id === selectedId) ?? draft.translationServices[0];
  const storedService = settings.translationServices.find((candidate) => candidate.id === service?.id);
  const testing = feedback?.serviceId === service?.id && feedback?.tone === 'testing';

  const patch = (id: string, changes: Partial<TranslationServiceInput>): void => {
    if (feedback?.serviceId === id || activeTest.current?.serviceId === id) {
      testVersion.current += 1;
      setFeedback(undefined);
    }
    const services = draft.translationServices.map((candidate) => candidate.id === id ? { ...candidate, ...changes } : candidate);
    const activeTranslationServiceId = services.some((candidate) => candidate.id === draft.activeTranslationServiceId && candidate.enabled)
      ? draft.activeTranslationServiceId : services.find((candidate) => candidate.enabled)?.id;
    update({ ...draft, translationServices: services, activeTranslationServiceId });
  };
  const add = (): void => {
    if (draft.translationServices.length >= MAX_TRANSLATION_SERVICES) return;
    const next = emptyTranslationService();
    update({ ...draft, translationServices: [...draft.translationServices, next], activeTranslationServiceId: draft.activeTranslationServiceId || next.id });
    select(next.id);
  };
  const remove = (id: string): void => {
    testVersion.current += 1;
    setFeedback(undefined);
    const services = draft.translationServices.filter((candidate) => candidate.id !== id);
    const activeTranslationServiceId = draft.activeTranslationServiceId === id ? services.find((candidate) => candidate.enabled)?.id : draft.activeTranslationServiceId;
    update({ ...draft, translationServices: services, activeTranslationServiceId });
    select(services[0]?.id);
    document.getElementById('prefs-add-service')?.focus();
  };
  const test = async (target: TranslationServiceInput): Promise<void> => {
    const fingerprint = JSON.stringify(target);
    if (activeTest.current?.version === testVersion.current && activeTest.current.fingerprint === fingerprint) return;
    if (!target.apiUrl.trim() || !target.model.trim()) {
      setFeedback({ serviceId: target.id, tone: 'error', message: '请先填写接口地址和模型名称。' });
      return;
    }
    const version = ++testVersion.current;
    activeTest.current = { version, fingerprint, serviceId: target.id };
    setFeedback({ serviceId: target.id, tone: 'testing', message: '正在测试翻译服务…' });
    try {
      const result = await window.whisperWeb.testTranslationService(target);
      if (testVersion.current !== version) return;
      setFeedback({ serviceId: target.id, tone: 'success', message: `连接成功 · ${result.latencyMs} ms`, detail: `${result.mode === 'responses' ? 'Responses' : 'Chat Completions'} · ${result.endpoint} · ${result.responsePreview}` });
    } catch (cause) {
      if (testVersion.current !== version) return;
      setFeedback({ serviceId: target.id, tone: 'error', message: '测试失败', detail: cause instanceof Error ? cause.message : '未返回可用的翻译结果。' });
    } finally { if (activeTest.current?.version === version) activeTest.current = undefined; }
  };

  return <div className="prefs-translation">
    <section className="prefs-service-selector" aria-label="翻译服务列表">
      <header><div><h4>翻译服务</h4><p>{draft.translationServices.length >= MAX_TRANSLATION_SERVICES ? `已达到 ${MAX_TRANSLATION_SERVICES} 个服务上限。` : '为新任务选择默认服务。'}</p></div><GlassButton className="prefs-button" disabled={draft.translationServices.length >= MAX_TRANSLATION_SERVICES} id="prefs-add-service" onClick={add} type="button"><Icon name="translate" size={15} />添加服务</GlassButton></header>
      {draft.translationServices.length ? <div className="prefs-service-list">{draft.translationServices.map((candidate) => <button aria-pressed={candidate.id === service?.id} className="prefs-service-choice" key={candidate.id} onClick={() => select(candidate.id)} type="button"><span><strong>{candidate.name || '未命名服务'}</strong><small>{candidate.model || '填写模型后即可使用'}</small></span><span className="prefs-service-tags">{draft.activeTranslationServiceId === candidate.id ? <small>默认</small> : null}{!candidate.enabled ? <small>已停用</small> : null}<Icon name={candidate.id === service?.id ? 'check' : 'chevron-down'} size={16} /></span></button>)}</div> : <div className="prefs-service-empty"><Icon name="translate" size={28} /><strong>添加你的翻译服务</strong><p>支持 Responses 与 Chat Completions 接口。API Key 可选。</p></div>}
    </section>
    {service ? <>
      <PreferenceGroup title="连接信息" description="配置在运行服务的机器上保存，密钥不会回填到浏览器。">
        <div className="prefs-service-actions"><PreferenceToggle label="启用此服务" checked={service.enabled} onChange={(enabled) => patch(service.id, { enabled })} /><button aria-pressed={draft.activeTranslationServiceId === service.id} className="prefs-text-button" disabled={!service.enabled || draft.activeTranslationServiceId === service.id} onClick={() => update({ ...draft, activeTranslationServiceId: service.id })} type="button">{draft.activeTranslationServiceId === service.id ? '当前默认服务' : '设为默认'}</button><button className="prefs-text-button prefs-danger" onClick={() => remove(service.id)} type="button">移除服务</button></div>
        <div className="prefs-grid">
          <PreferenceField label="服务名称"><input maxLength={128} onChange={(event) => patch(service.id, { name: event.target.value })} value={service.name} /></PreferenceField>
          <PreferenceField label="翻译模型"><input maxLength={256} onChange={(event) => patch(service.id, { model: event.target.value })} placeholder="服务支持的模型名称" spellCheck={false} value={service.model} /></PreferenceField>
          <PreferenceField label="API 接口地址" hint="使用服务提供的完整 HTTP / HTTPS 地址。" wide><input maxLength={2048} onChange={(event) => patch(service.id, { apiUrl: event.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} type="url" value={service.apiUrl} /></PreferenceField>
          <PreferenceField label="API Key（可选）" hint={service.apiKey ? '保存后替换本机加密密钥。' : service.clearApiKey ? '保存后删除该服务的本机密钥。' : storedService?.apiKeyConfigured ? storedService.apiKeySource === 'env' ? '由运行环境提供；留空保持现状。' : '已在本机加密保存；留空保持现状。' : '匿名接口可留空。'} wide><input autoComplete="off" maxLength={4096} onChange={(event) => patch(service.id, { apiKey: event.target.value, clearApiKey: false })} placeholder="输入新密钥，留空保留已存密钥" spellCheck={false} type="password" value={service.apiKey || ''} /></PreferenceField>
        </div>
        {storedService?.apiKeySource === 'stored' ? <PreferenceToggle label="删除已保存的密钥" hint="只在保存设置后删除当前服务的本机密钥。环境变量中的密钥不会被删除。" checked={Boolean(service.clearApiKey)} onChange={(clearApiKey) => patch(service.id, { clearApiKey, apiKey: clearApiKey ? '' : service.apiKey })} /> : null}
        <div className="prefs-test-service"><GlassButton className="prefs-button" disabled={testing} onClick={() => void test(service)} type="button"><Icon name={testing ? 'clock' : 'check'} size={15} />{testing ? '正在测试…' : '测试连接'}</GlassButton><small>测试当前草稿，不必先保存。</small></div>
        {feedback?.serviceId === service.id ? <div className={`prefs-feedback prefs-feedback-${feedback.tone}`} role="status"><strong>{feedback.message}</strong>{feedback.detail ? <p>{feedback.detail}</p> : null}</div> : null}
      </PreferenceGroup>
      <PreferenceGroup title="翻译方式">
        <PreferenceToggle label="智能上下文" hint="利用相邻字幕辅助理解。" checked={service.enableAiContext} onChange={(enableAiContext) => patch(service.id, { enableAiContext })} />
        <PreferenceToggle label="保留富文本" hint="保留链接和轻量标记。" checked={service.enableRichTranslate} onChange={(enableRichTranslate) => patch(service.id, { enableRichTranslate })} />
        <PreferenceField label="翻译策略" hint="可指定熟悉字幕、技术术语或人物语气的专家。" wide><textarea maxLength={10000} onChange={(event) => patch(service.id, { customContent: event.target.value })} rows={3} value={service.customContent} /></PreferenceField>
      </PreferenceGroup>
      <details className="prefs-advanced"><summary>提示词与请求参数<Icon name="chevron-down" size={16} /></summary><div className="prefs-advanced-content"><div className="prefs-grid">{serviceNumberFields.map(({ key, label, min, max, step }) => <PreferenceField key={key} label={label}><input max={max} min={min} onChange={(event) => patch(service.id, { [key]: Number(event.target.value) })} step={step} type="number" value={service[key]} /></PreferenceField>)}</div>{promptFields.map(({ key, label, hint }) => <PreferenceField hint={hint} key={key} label={label} wide><textarea maxLength={20000} onChange={(event) => patch(service.id, { [key]: event.target.value })} rows={3} value={service[key]} /></PreferenceField>)}</div></details>
    </> : null}
  </div>;
}
