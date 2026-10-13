import { useEffect, useId, useRef, useState } from 'react';

import type { ModelPreparationState, ToastEvent } from '../../shared/types';
import Icon from '../components/Icon';
import { GlassButton, GlassSurface } from '../glass';
import { useDialogInteraction } from '../hooks/useDialogInteraction';
import type { WhisperWorkspaceController } from '../hooks/useWhisperWorkspace';
import { formatDateTime, normalizeUiText } from '../utils';

interface SystemPanelProps {
  workspace: WhisperWorkspaceController;
  onClose: () => void;
  onPreferences: () => void;
}

export function SystemPanel({ workspace, onClose, onPreferences }: SystemPanelProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [requested, setRequested] = useState<ModelPreparationState>();
  const inFlight = useRef(false);
  const titleId = useId();
  useDialogInteraction(panelRef, { onDismiss: onClose, initialFocusRef: closeRef });
  const snapshot = workspace.snapshot!;
  const { settings, environment } = snapshot;
  useEffect(() => {
    setRequested((current) => current && snapshot.modelPreparations?.some((item) => item.id === current.id) ? undefined : current);
  }, [snapshot.modelPreparations, requested?.id]);
  const selectedModel = settings.transcriptionEngine === 'whisper.cpp'
    ? ({ turbo: 'large-v3-turbo', large: 'large-v3' }[settings.whisperModel] || settings.whisperModel) : settings.whisperModel;
  const states = requested && !snapshot.modelPreparations?.some((item) => item.id === requested.id)
    ? [...(snapshot.modelPreparations ?? []), requested] : snapshot.modelPreparations ?? [];
  const selected = [...states].reverse().find((item) => item.pythonPath === settings.pythonPath && item.engine === settings.transcriptionEngine && item.model === selectedModel);
  const visible = states.filter((item) => ['preparing', 'queued'].includes(item.status));
  if (selected && !visible.some((item) => item.id === selected.id)) visible.push(selected);

  async function action(operation: () => Promise<unknown>): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; setPending(false); }
  }

  return (
    <div className="studio-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="studio-modal studio-system" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef} tabIndex={-1}>
        <GlassSurface className="studio-modal-heading" radius={0} refractionAmount={14}>
          <div><p className="studio-eyebrow">运行状态</p><h2 id={titleId}>一切都在这里</h2><p>最近检查：{formatDateTime(environment.checkedAt)}</p></div>
          <button ref={closeRef} aria-label="关闭系统状态" className="studio-icon-button studio-button" onClick={onClose} type="button"><Icon name="close" /></button>
        </GlassSurface>
        <div className="studio-modal-body">
          <div className="studio-system-summary"><span>{environment.items.filter((item) => item.ok).length} / {environment.items.length} 项可用</span><GlassButton disabled={pending} onClick={() => void action(() => workspace.reload())}><Icon name="retry" size={16} />{pending ? '正在检查…' : '重新检查'}</GlassButton></div>
          <div className="studio-check-list">
            {environment.items.map((item) => <article className="studio-check" key={item.key}>
              <span className={item.ok ? 'studio-success' : 'studio-warning'}><Icon name={item.ok ? 'check' : 'warning'} size={19} /></span>
              <div><div className="studio-check-title"><h3>{item.label}</h3><span className={item.ok ? 'studio-success' : 'studio-warning'}>{item.ok ? '可用' : '需处理'}</span></div><p>{normalizeUiText(item.details)}</p>{item.suggestion ? <small>{normalizeUiText(item.suggestion)}</small> : null}</div>
            </article>)}
            {!environment.items.length ? <p className="studio-muted">暂时没有检查结果，请重新检查。</p> : null}
          </div>
          <section className="studio-model-status" aria-label="模型准备">
            <div className="studio-section-heading"><h3>转写模型</h3><span>{settings.transcriptionEngine}</span></div>
            {!selected ? <div className="studio-model-row"><div><strong>{settings.whisperModel}</strong><p>首次转写会自动准备，也可以现在下载。</p></div><GlassButton disabled={pending} onClick={() => void action(async () => setRequested(await window.whisperWeb.prepareModel()))}>准备模型</GlassButton></div> : null}
            {visible.map((item) => {
              const active = item.status === 'queued' || item.status === 'preparing';
              const value = active && Number.isFinite(item.percent) ? Math.max(0, Math.min(100, item.percent!)) : undefined;
              return <article className="studio-model-row" key={item.id}>
                <div><strong>{item.model}</strong><small>{item.engine} · {{ queued: '等待准备', preparing: '正在下载', ready: '已就绪', failed: '准备失败', cancelled: '已取消' }[item.status]}</small><p>{normalizeUiText(item.error || item.message)}</p>
                  {active ? <div className="studio-model-progress" role="progressbar" aria-label={`${item.model} 模型准备进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={value === undefined ? item.message : `${value}%`}><span style={{ transform: `scaleX(${(value ?? 0) / 100})` }} /></div> : null}
                </div>
                {active ? <GlassButton disabled={pending} onClick={() => void action(async () => { if (!await window.whisperWeb.cancelModelPreparation(item.id)) throw new Error('状态已更新，请重新检查。'); })}>取消</GlassButton> : item.status === 'failed' || item.status === 'cancelled' ? <GlassButton disabled={pending} onClick={() => void action(async () => setRequested(await window.whisperWeb.prepareModel()))}>重试</GlassButton> : null}
              </article>;
            })}
            {error || workspace.loadError ? <p className="studio-error" role="alert">{normalizeUiText(error || workspace.loadError)}</p> : null}
          </section>
        </div>
        <GlassSurface className="studio-modal-footer" radius={0} refractionAmount={14}><p>模型在后台准备，完成后等待中的任务会自动继续。</p><GlassButton onClick={onPreferences}>打开偏好设置</GlassButton></GlassSurface>
      </div>
    </div>
  );
}

export function Confirmation({ workspace }: { workspace: WhisperWorkspaceController }): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const request = workspace.confirmation!;
  useDialogInteraction(panelRef, { onDismiss: workspace.dismissConfirmation, canDismiss: !workspace.confirming, initialFocusRef: cancelRef });
  return <div className="studio-modal-backdrop studio-confirm-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !workspace.confirming) workspace.dismissConfirmation(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="studio-modal studio-confirm" ref={panelRef} tabIndex={-1}>
      <span className={request.tone === 'danger' ? 'studio-danger' : 'studio-muted'}><Icon name={request.tone === 'danger' ? 'trash' : 'info'} size={32} /></span>
      <h2 id={titleId}>{request.title}</h2><p>{request.message}</p>
      <div className="studio-confirm-actions"><button ref={cancelRef} className="studio-button" disabled={workspace.confirming} onClick={workspace.dismissConfirmation} type="button">取消</button><GlassButton className={request.tone === 'danger' ? 'studio-destructive' : 'studio-primary'} disabled={workspace.confirming} onClick={() => void workspace.confirmAction()}>{workspace.confirming ? '正在处理…' : request.confirmLabel}</GlassButton></div>
    </div>
  </div>;
}

export function Notifications({ toasts }: { toasts: ToastEvent[] }): React.JSX.Element {
  return <div className="studio-notifications" aria-live="polite" aria-atomic="false">
    {toasts.slice(-4).map((item) => <article className={`studio-notification studio-notification--${item.tone}`} key={item.id} role={item.tone === 'error' ? 'alert' : 'status'}>
      <Icon name={item.tone === 'success' ? 'check' : item.tone === 'warning' || item.tone === 'error' ? 'warning' : 'info'} size={19} /><div><strong>{normalizeUiText(item.title)}</strong><p>{normalizeUiText(item.message)}</p></div>
    </article>)}
  </div>;
}
