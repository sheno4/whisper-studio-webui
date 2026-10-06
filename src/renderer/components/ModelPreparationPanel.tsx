import { useEffect, useRef, useState } from 'react';

import type { ModelPreparationState, SettingsData } from '../../shared/types';
import { formatProgressPercent, normalizeUiText } from '../utils';
import Icon from './Icon';

interface ModelPreparationPanelProps {
  settings: Pick<SettingsData, 'pythonPath' | 'transcriptionEngine' | 'whisperModel'>;
  preparations?: ModelPreparationState[];
}

const isPreparing = (state: ModelPreparationState): boolean => state.status === 'queued' || state.status === 'preparing';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
};

const describeBytes = (state: ModelPreparationState): string | undefined => {
  if (state.downloadedBytes === undefined || !Number.isFinite(state.downloadedBytes) || state.downloadedBytes < 0) return undefined;
  const downloaded = formatBytes(state.downloadedBytes);
  return state.totalBytes !== undefined && Number.isFinite(state.totalBytes) && state.totalBytes > 0
    ? `${downloaded} / ${formatBytes(state.totalBytes)}`
    : `已下载 ${downloaded}`;
};

function ModelPreparationPanel({ settings, preparations = [] }: ModelPreparationPanelProps): React.JSX.Element {
  const [requestedState, setRequestedState] = useState<ModelPreparationState>();
  const [pendingAction, setPendingAction] = useState<string>();
  const [operationError, setOperationError] = useState('');
  const actionInFlight = useRef(false);
  useEffect(() => {
    setRequestedState((current) => current && preparations.some((state) => state.id === current.id) ? undefined : current);
  }, [preparations, requestedState?.id]);
  const selectedModel = settings.transcriptionEngine === 'whisper.cpp'
    ? ({ turbo: 'large-v3-turbo', large: 'large-v3' }[settings.whisperModel] || settings.whisperModel)
    : settings.whisperModel;
  const matchesSelection = (state: ModelPreparationState): boolean => state.pythonPath === settings.pythonPath && state.engine === settings.transcriptionEngine && state.model === selectedModel;
  // The request response is useful before its first stream event arrives. Once
  // the stream knows this id, its newer progress always takes precedence.
  const states = requestedState && !preparations.some((state) => state.id === requestedState.id)
    ? [...preparations, requestedState]
    : preparations;
  const selected = [...states].reverse().find(matchesSelection);
  const visible = states.filter(isPreparing);
  if (selected && !visible.some((state) => state.id === selected.id)) visible.push(selected);

  const prepare = async (): Promise<void> => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setPendingAction('prepare');
    setOperationError('');
    try {
      setRequestedState(await window.whisperWeb.prepareModel());
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : '无法准备模型，请稍后重试。');
    } finally {
      actionInFlight.current = false;
      setPendingAction(undefined);
    }
  };

  const cancel = async (state: ModelPreparationState): Promise<void> => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setPendingAction(state.id);
    setOperationError('');
    try {
      if (!await window.whisperWeb.cancelModelPreparation(state.id)) {
        throw new Error('模型准备状态已更新，请查看当前进度。');
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : '取消失败，请稍后重试。');
    } finally {
      actionInFlight.current = false;
      setPendingAction(undefined);
    }
  };

  return (
    <section aria-label="转写模型" className="model-preparation-panel">
      <div className="model-preparation-list">
        {visible.map((state) => {
          const active = isPreparing(state);
          const current = selected?.id === state.id;
          const percent = active && state.percent !== undefined && Number.isFinite(state.percent)
            ? Math.max(0, Math.min(100, state.percent))
            : undefined;
          const bytes = active ? describeBytes(state) : undefined;
          const statusLabel = {
            queued: '等待准备', preparing: '正在准备', ready: '已就绪', failed: '准备失败', cancelled: '已取消'
          }[state.status];
          const message = normalizeUiText(state.status === 'failed' ? state.error || state.message : state.message);
          return (
            <article className={`model-preparation-row model-preparation-row--${state.status}`} key={state.id}>
              <Icon name={state.status === 'ready' ? 'check' : state.status === 'failed' ? 'warning' : active ? 'download' : 'model'} size={17} />
              <div className="model-preparation-copy">
                <div className="model-preparation-heading">
                  <strong>{state.model}</strong>
                  <span>{state.engine}</span>
                  {current ? <small>当前模型</small> : null}
                  <span className="model-preparation-status">{statusLabel}</span>
                </div>
                {state.status !== 'ready' ? <p role="status">{message || statusLabel}</p> : null}
                {active ? (
                  <div className="model-preparation-progress">
                    <progress aria-label={`${state.model} 模型准备进度`} max={100} value={percent} />
                    {percent !== undefined || bytes ? <small>{[formatProgressPercent(percent), bytes].filter(Boolean).join(' · ')}</small> : null}
                  </div>
                ) : null}
              </div>
              {active ? (
                <button className="ghost-button model-preparation-action" disabled={pendingAction !== undefined} onClick={() => void cancel(state)} type="button">
                  {pendingAction === state.id ? '正在取消…' : '取消'}
                </button>
              ) : current && (state.status === 'failed' || state.status === 'cancelled') ? (
                <button className="ghost-button model-preparation-action" disabled={pendingAction !== undefined} onClick={() => void prepare()} type="button">
                  {pendingAction === 'prepare' ? '正在重试…' : '重试'}
                </button>
              ) : null}
            </article>
          );
        })}
        {!selected ? (
          <div className="model-preparation-row">
            <Icon name="model" size={17} />
            <div className="model-preparation-copy">
              <div className="model-preparation-heading"><strong>{settings.whisperModel}</strong><span>{settings.transcriptionEngine}</span><small>当前模型</small></div>
              <p>首次使用会自动准备模型，转写任务会等待模型就绪。</p>
            </div>
            <button className="ghost-button model-preparation-action" disabled={pendingAction !== undefined} onClick={() => void prepare()} type="button">
              {pendingAction === 'prepare' ? '正在准备…' : '准备模型'}
            </button>
          </div>
        ) : null}
      </div>
      {visible.some(isPreparing) ? <p className="model-preparation-note">模型在后台准备，完成后使用该模型的任务会自动开始转写。</p> : null}
      {operationError ? <p className="model-preparation-error" role="alert">{normalizeUiText(operationError)}</p> : null}
    </section>
  );
}

export default ModelPreparationPanel;
