import type { HistoryRecord, TaskRecord } from '../../../shared/types';
import Icon from '../../components/Icon';
import { GlassButton } from '../../glass';
import type { WhisperWorkspaceController } from '../../hooks/useWhisperWorkspace';
import { getReadableName, isTaskActive } from '../../utils';
import ActionMenu from './ActionMenu';

interface TaskActionsProps {
  workspace: WhisperWorkspaceController;
  record: TaskRecord | HistoryRecord;
  source: 'queue' | 'history';
  result?: TaskRecord;
  variant?: 'menu' | 'row';
  scope?: 'all' | 'files' | 'management';
}

/** A history result can describe an older attempt. Management always uses the
 * current queue state, while file actions keep the displayed result's paths. */
export default function TaskActions({ workspace, record, source, result, variant = 'menu', scope = 'all' }: TaskActionsProps): React.JSX.Element {
  const liveTask = workspace.snapshot?.tasks.find((task) => task.id === record.id);
  const active = Boolean(liveTask && isTaskActive(liveTask));
  const selectedHistoryResult = workspace.activity.view === 'history' && workspace.activity.activeHistoryRecord?.id === record.id
    ? workspace.activity.activeTask : undefined;
  const finishedHistoryResult = 'finishedAt' in record && liveTask && liveTask.updatedAt === record.finishedAt && !isTaskActive(liveTask)
    ? liveTask : undefined;
  const displayedTask = source === 'queue' ? liveTask ?? result ?? ('outputFiles' in record ? record : undefined) : result ?? selectedHistoryResult ?? finishedHistoryResult;
  const outputDir = source === 'history' ? record.outputDir : liveTask?.outputDir ?? record.outputDir;
  const mediaPath = displayedTask?.outputFiles.sourceMedia || displayedTask?.outputFiles.downloadedMedia || displayedTask?.outputFiles.audio
    || (record.sourceType === 'file' ? displayedTask?.input || record.input : undefined);
  const showFiles = scope !== 'management';
  const showManagement = scope !== 'files';
  const retryable = source === 'queue' && liveTask && ['failed', 'cancelled', 'partial'].includes(liveTask.status);
  const openOutput = (): void => {
    if (!outputDir) return;
    if (source === 'history') void workspace.revealPath(outputDir);
    else void workspace.openOutputDirectory(record.id);
  };
  const revealMedia = (): void => { if (mediaPath) void workspace.revealPath(mediaPath); };
  const fileActions = showFiles ? variant === 'row' ? <>
    <GlassButton disabled={!outputDir} onClick={openOutput}><Icon name="folder" />打开输出目录</GlassButton>
    <GlassButton disabled={!mediaPath} title={!mediaPath ? '暂无可定位的媒体文件' : undefined} onClick={revealMedia}><Icon name="external" />定位媒体文件</GlassButton>
  </> : <>
    <button disabled={!outputDir} onClick={openOutput} type="button"><Icon name="folder" />打开输出目录</button>
    <button disabled={!mediaPath} title={!mediaPath ? '暂无可定位的媒体文件' : undefined} onClick={revealMedia} type="button"><Icon name="external" />定位媒体文件</button>
  </> : null;
  const managementActions = showManagement ? <>
    {retryable ? <button className={variant === 'row' ? 'studio-text-button' : undefined} onClick={() => void workspace.retryTask(record.id)} type="button"><Icon name="retry" />重新执行任务</button> : null}
    {active ? <button className={variant === 'row' ? 'studio-text-button' : undefined} onClick={() => void workspace.cancelTask(record.id)} type="button"><Icon name="stop" />取消当前任务</button> : null}
    {variant === 'menu' ? <div className="studio-task-action-separator" role="separator" /> : null}
    <button className={`${variant === 'row' ? 'studio-text-button ' : ''}studio-danger`} disabled={active} title={active ? '请先取消当前任务，再删除任务及其文件' : undefined} onClick={() => workspace.requestDeleteTask(record.id)} type="button"><Icon name="trash" />删除任务…</button>
  </> : null;

  return variant === 'menu' ? <ActionMenu className="workbench-task-menu" ariaLabel={`${getReadableName(record)}的操作`} label={<span aria-hidden="true">···</span>}>
    {fileActions}{managementActions}
  </ActionMenu> : <>{fileActions}{managementActions}</>;
}
