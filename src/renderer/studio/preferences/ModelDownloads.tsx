import { useRef, useState } from 'react';

import type { ModelPreparationState, SettingsData } from '../../../shared/types';
import Icon from '../../components/Icon';
import { GlassButton, GlassProgress } from '../../glass';
import { normalizeUiText } from '../../utils';

interface ModelDownloadsProps {
  settings: SettingsData;
  preparations: ModelPreparationState[];
  unsavedSelection: boolean;
  saveDraft: () => Promise<boolean>;
}

const labels: Record<ModelPreparationState['status'], string> = { queued: '等待下载', preparing: '正在准备', ready: '可用', failed: '失败', cancelled: '已取消' };
const isActive = (state: ModelPreparationState): boolean => state.status === 'queued' || state.status === 'preparing';
const bytes = (value: number): string => {
  const unit = value >= 1024 ? Math.min(3, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
};

export default function ModelDownloads({ settings, preparations, unsavedSelection, saveDraft }: ModelDownloadsProps): React.JSX.Element {
  const [requested, setRequested] = useState<ModelPreparationState>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState('');
  const actionLock = useRef(false);
  const visiblePreparations=useRef(new Set<string>());
  const states = requested && !preparations.some((state) => state.id === requested.id) ? [...preparations, requested] : preparations;
  const normalizedModel = settings.transcriptionEngine === 'whisper.cpp' ? ({ large: 'large-v3', turbo: 'large-v3-turbo' }[settings.whisperModel] || settings.whisperModel) : settings.whisperModel;
  const selected = [...states].reverse().find((state) => state.pythonPath === settings.pythonPath && state.engine === settings.transcriptionEngine && state.model === normalizedModel);
  for(const state of states)if(isActive(state))visiblePreparations.current.add(state.id);
  const visible = states.filter(state=>isActive(state)||state.status==='ready'&&visiblePreparations.current.has(state.id));
  if (selected && !visible.some((state) => state.id === selected.id)) visible.push(selected);

  const prepare = async (): Promise<void> => {
    if (actionLock.current) return;
    actionLock.current = true;
    setPending('prepare');
    setError('');
    try {
      if (unsavedSelection && !await saveDraft()) return;
      setRequested(await window.whisperWeb.prepareModel());
    } catch (cause) { setError(cause instanceof Error ? cause.message : '模型准备失败，请重试。'); }
    finally { actionLock.current = false; setPending(undefined); }
  };
  const cancel = async (state: ModelPreparationState): Promise<void> => {
    if (actionLock.current) return;
    actionLock.current = true;
    setPending(state.id);
    setError('');
    try { if (!await window.whisperWeb.cancelModelPreparation(state.id)) throw new Error('模型状态已经更新，请查看最新进度。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法取消模型准备。'); }
    finally { actionLock.current = false; setPending(undefined); }
  };

  return <div className="prefs-models">
    <header className="prefs-models-title"><div><strong>模型下载</strong><small>在后台准备，任务自动等待就绪。</small></div><GlassButton className="prefs-button" disabled={Boolean(pending) || (!unsavedSelection && Boolean(selected && isActive(selected)))} onClick={() => void prepare()} type="button"><Icon name="download" size={15} />{pending === 'prepare' ? '正在请求…' : unsavedSelection ? '保存并准备模型' : selected?.status === 'failed' || selected?.status === 'cancelled' ? '重新准备模型' : '准备模型'}</GlassButton></header>
    {unsavedSelection ? <p className="prefs-note">下面显示已保存配置的状态；准备新模型时会同时保存当前设置。</p> : null}
    {visible.length ? <div className="prefs-model-list">{visible.map((state) => {
      const ready=state.status==='ready';
      const percent = ready ? 100 : state.percent !== undefined && Number.isFinite(state.percent) ? Math.max(0, Math.min(100, state.percent)) : undefined;
      const hasBytes = state.downloadedBytes !== undefined && Number.isFinite(state.downloadedBytes) && state.downloadedBytes >= 0;
      return <article className="prefs-model" key={state.id}>
        <div className="prefs-model-title"><span><strong>{state.model}</strong><small>{state.engine}</small></span><span className={`prefs-status prefs-status-${state.status}`}>{labels[state.status]}</span>{isActive(state) ? <button className="prefs-text-button" disabled={Boolean(pending)} onClick={() => void cancel(state)} type="button">{pending === state.id ? '取消中…' : '取消下载'}</button> : null}</div>
        <p className={state.status === 'failed' ? 'prefs-error' : ''} title={normalizeUiText(state.error || state.message)}>{normalizeUiText(state.error || state.message)}</p>
        {isActive(state)||ready ? <GlassProgress label={`${state.model} 准备进度`} value={percent} caption={hasBytes?`${bytes(state.downloadedBytes!)}${state.totalBytes&&state.totalBytes>0?` / ${bytes(state.totalBytes)}`:' 已下载'}`:ready?'模型已就绪':'正在准备'} displayValue={ready?undefined:percent===undefined?'进度待确认':`${percent.toFixed(1)}%`} valueText={ready?'100% · 已完成':percent===undefined?'正在准备，进度待确认':`${Math.round(percent)}%`} active={isActive(state)}/> : null}
      </article>;
    })}</div> : <p className="prefs-note">当前配置：{settings.transcriptionEngine} · {settings.whisperModel}。尚未收到准备状态。</p>}
    {error ? <p className="prefs-error" role="alert">{error}</p> : null}
  </div>;
}
