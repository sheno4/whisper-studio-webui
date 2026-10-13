import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ExportFileKind, TaskOutputFiles, TaskRecord } from '../../shared/types';
import Icon from '../components/Icon';
import { GlassButton, GlassSurface } from '../glass';
import type { WhisperWorkspaceController } from '../hooks/useWhisperWorkspace';
import { describeTaskLanguage, describeTaskMode, formatDuration, formatLongDateTime, getReadableName, isTaskActive, normalizeUiText, statusLabels, statusTones } from '../utils';
import { TaskProgress } from './Library';
import { formatTimestamp, literalMatches, mergeTranscript, pairSegments } from './content/transcript';
import ActionMenu from './content/ActionMenu';

export interface ReaderProps {
  workspace: WhisperWorkspaceController;
  onBack: () => void;
}

type ReadingMode = 'original' | 'translation' | 'bilingual' | 'logs';
const readingModes: Array<{ value: ReadingMode; label: string }> = [{ value: 'original', label: '原文' }, { value: 'translation', label: '译文' }, { value: 'bilingual', label: '双语' }, { value: 'logs', label: '日志' }];
const exportOptions: Array<{ kind: ExportFileKind; label: string; translated: boolean }> = [
  { kind: 'transcriptTxt', label: 'TXT', translated: false }, { kind: 'transcriptSrt', label: 'SRT', translated: false }, { kind: 'transcriptVtt', label: 'VTT', translated: false }, { kind: 'transcriptJson', label: 'JSON', translated: false },
  { kind: 'translationTxt', label: 'TXT', translated: true }, { kind: 'translationSrt', label: 'SRT', translated: true }, { kind: 'translationVtt', label: 'VTT', translated: true }, { kind: 'translationJson', label: 'JSON', translated: true }
];
const outputLabels: Record<keyof TaskOutputFiles, string> = {
  transcriptTxt: '原文文本', transcriptSrt: '原文字幕 · SRT', transcriptVtt: '原文字幕 · VTT', transcriptJson: '原文数据 · JSON', translationTxt: '中文文本', translationSrt: '中文字幕 · SRT', translationVtt: '中文字幕 · VTT', translationJson: '中文数据 · JSON', audio: '处理音频', downloadedMedia: '已下载媒体', sourceMedia: '原始媒体', logFile: '处理日志', metadataJson: '任务信息'
};

function Highlight({ text, query }: { text: string; query: string }): React.JSX.Element {
  const matches = literalMatches(text, query);
  if (!matches.length) return <>{text}</>;
  const content: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match) => {
    content.push(text.slice(cursor, match.start), <mark data-reader-hit key={match.start}>{text.slice(match.start, match.end)}</mark>);
    cursor = match.end;
  });
  content.push(text.slice(cursor));
  return <>{content}</>;
}

function safeSourceUrl(task: TaskRecord): string | undefined {
  const input = task.mediaInfo?.webpageUrl ?? (task.sourceType === 'link' ? task.input : undefined);
  if (!input) return undefined;
  try { const url = new URL(input); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

export default function Reader({ workspace, onBack }: ReaderProps): React.JSX.Element {
  const task = workspace.activity.activeTask;
  const history = workspace.activity.activeHistoryRecord;
  const record = task ?? history;
  const [mode, setMode] = useState<ReadingMode>('original');
  const [segmented, setSegmented] = useState(false);
  const [timestamps, setTimestamps] = useState(true);
  const [query, setQuery] = useState('');
  const [currentHit, setCurrentHit] = useState(-1);
  const [removing, setRemoving] = useState(false);
  const removalRequested = useRef(false);
  const readingRef = useRef<HTMLDivElement>(null);
  const original = mergeTranscript(task?.transcriptText, task?.transcriptSegments);
  const translation = mergeTranscript(task?.translationText, task?.translationSegments);
  const rows = useMemo(() => pairSegments(task?.transcriptSegments ?? [], task?.translationSegments ?? []), [task?.transcriptSegments, task?.translationSegments]);
  const active = Boolean(task && isTaskActive(task));
  const logText = task?.logs.map((entry) => `${formatLongDateTime(entry.timestamp)} [${entry.level}] ${entry.message}${entry.context ? `\n${entry.context}` : ''}`).join('\n') ?? '';
  const textToCopy = mode === 'logs' ? logText : mode === 'translation' ? translation : mode === 'bilingual' ? segmented && rows.length ? rows.map((row) => [row.original, row.translation].filter(Boolean).join('\n')).join('\n\n') : [original, translation].filter(Boolean).join('\n\n') : original;
  const displayStrings = mode === 'logs' ? task?.logs.flatMap((entry) => [normalizeUiText(entry.message), entry.context ?? '']) ?? [] : segmented && rows.length ? rows.flatMap((row) => mode === 'original' ? [row.original ?? ''] : mode === 'translation' ? [row.translation ?? ''] : [row.original ?? '', row.translation ?? '']) : mode === 'original' ? [original] : mode === 'translation' ? [translation] : [original, translation];
  const hitCount = displayStrings.reduce((count, text) => count + literalMatches(text, query).length, 0);

  useEffect(() => { readingRef.current?.querySelectorAll('[data-reader-hit]').forEach((hit) => hit.removeAttribute('data-current')); setCurrentHit(-1); }, [query, mode, segmented, record?.id, mode === 'logs' ? logText : original, mode === 'logs' ? '' : translation]);
  useEffect(() => { if (removalRequested.current && !record) onBack(); }, [record, onBack]);
  const removeRecord = async (): Promise<void> => {
    if (!record || removing) return;
    removalRequested.current = true;
    setRemoving(true);
    try { await (history ? workspace.removeHistory(history.id) : workspace.removeTask(record.id)); }
    finally { setRemoving(false); }
  };
  const jumpToHit = (direction: number): void => {
    const hits = readingRef.current?.querySelectorAll<HTMLElement>('[data-reader-hit]');
    if (!hits?.length) return;
    const next = currentHit < 0 ? direction > 0 ? 0 : hits.length - 1 : (currentHit + direction + hits.length) % hits.length;
    hits.forEach((hit, index) => hit.toggleAttribute('data-current', index === next));
    hits[next].scrollIntoView({ block: 'center', behavior: 'auto' });
    setCurrentHit(next);
  };

  if (!record) return <section className="studio-reader-empty"><h1>这项记录已不在资料库中</h1><GlassButton onClick={onBack}>返回资料库</GlassButton></section>;
  const sourceUrl = task ? safeSourceUrl(task) : undefined;
  const hasText = Boolean(mode === 'translation' ? translation : mode === 'bilingual' ? original || translation : original);
  const outputs = task ? Object.entries(task.outputFiles).filter((entry): entry is [keyof TaskOutputFiles, string] => Boolean(entry[1])) : [];
  const meta = [record.sourceType === 'link' ? '在线媒体' : '本地文件', task ? describeTaskMode(task) : undefined, describeTaskLanguage(record), formatDuration(task?.mediaInfo?.durationSeconds ?? history?.durationSeconds), `创建于 ${formatLongDateTime(record.createdAt)}`].filter((value): value is string => Boolean(value && value !== '--'));
  return (
    <section className="studio-reader" aria-labelledby="studio-reader-title">
      <div className="studio-reader-path"><GlassButton onClick={onBack}><span aria-hidden="true">←</span>资料库</GlassButton><span className={`studio-status is-${statusTones[record.status]}`}><span aria-hidden="true" />{statusLabels[record.status]}</span></div>
      <header className="studio-reader-heading"><p className="studio-eyebrow">{history ? '历史记录' : task?.downloadBehavior === 'downloadOnly' ? '媒体文件' : '阅读与导出'}</p><h1 id="studio-reader-title">{getReadableName(record)}</h1>{task ? <p className="studio-reader-source">{task.input}</p> : null}</header>
      {task && active ? <div className="studio-reader-live"><TaskProgress task={task} /></div> : null}
      {record.error ? <div className="studio-notice is-danger" role="alert"><Icon name="warning" /><div><strong>处理未完成{task?.errorCode ? ` · ${task.errorCode}` : ''}</strong><p>{normalizeUiText(record.error)}</p></div></div> : null}
      {task?.warning || task?.mediaInfo?.qualityFallbackMessage ? <div className="studio-notice"><Icon name="info" /><p>{normalizeUiText(task.warning || task.mediaInfo?.qualityFallbackMessage)}</p></div> : null}

      {task ? <>
        <GlassSurface className="studio-reading-tools" as="nav" radius={24} aria-label="阅读工具">
          <div className="studio-reading-modes" role="group" aria-label="阅读内容">{readingModes.map((option) => <button type="button" key={option.value} className={mode === option.value ? 'is-selected' : ''} aria-pressed={mode === option.value} onClick={() => setMode(option.value)}>{option.label}{option.value === 'logs' ? <small>{task.logs.length}</small> : null}</button>)}</div>
          <div className="studio-reading-actions"><button disabled={!textToCopy.trim()} className="studio-tool-button" onClick={() => void workspace.copyText(textToCopy, mode === 'logs' ? '处理日志' : mode === 'translation' ? '中文译文' : mode === 'bilingual' ? '双语文本' : '原文')} type="button"><Icon name="copy" />复制</button><ActionMenu label={<><Icon name="download" />导出</>} ariaLabel="导出文件">{[false, true].map((translated) => <div className="studio-export-group" role="group" aria-label={translated ? '导出译文' : '导出原文'} key={String(translated)}><strong>{translated ? '中文译文' : '转写原文'}</strong><div>{exportOptions.filter((option) => option.translated === translated).map((option) => <button disabled={!task.outputFiles[option.kind]} key={option.kind} onClick={() => void workspace.exportTaskFile(task.id, option.kind)} type="button" role="menuitem">{option.label}</button>)}</div></div>)}</ActionMenu></div>
        </GlassSurface>
        <div className="studio-reading-preferences">
          <label className="studio-reader-search"><span className="studio-visually-hidden">搜索当前内容</span><input type="search" placeholder="在当前内容中查找" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); jumpToHit(event.shiftKey ? -1 : 1); } }} /></label>
          {query.trim() ? <div className="studio-find-controls" aria-label="查找结果"><span aria-live="polite">{currentHit >= 0 ? `${currentHit + 1} / ` : ''}{hitCount} 处</span><button type="button" disabled={!hitCount} onClick={() => jumpToHit(-1)} aria-label="上一个匹配">↑</button><button type="button" disabled={!hitCount} onClick={() => jumpToHit(1)} aria-label="下一个匹配">↓</button></div> : null}
          {mode !== 'logs' && rows.length ? <div className="studio-reading-format"><label><input type="checkbox" checked={segmented} onChange={(event) => setSegmented(event.target.checked)} />分段阅读</label>{segmented ? <label><input type="checkbox" checked={timestamps} onChange={(event) => setTimestamps(event.target.checked)} />时间戳</label> : null}</div> : null}
        </div>
        <div className={`studio-reading-page${mode === 'bilingual' ? ' is-bilingual' : ''}`} ref={readingRef} aria-label={readingModes.find((option) => option.value === mode)?.label}>
          {mode === 'logs' ? task.logs.length ? <ol className="studio-log-stream">{task.logs.map((entry, index) => <li key={`${entry.timestamp}-${index}`} className={`is-${entry.level}`}><header><time dateTime={entry.timestamp}>{formatLongDateTime(entry.timestamp)}</time><span>{entry.level}</span></header><p><Highlight text={normalizeUiText(entry.message)} query={query} /></p>{entry.context ? <pre><Highlight text={entry.context} query={query} /></pre> : null}</li>)}</ol> : <div className="studio-reading-empty"><Icon name="terminal" size={30} /><h2>处理开始后会生成日志</h2><p>下载、转写和翻译的进度会记录在这里。</p></div> : !hasText ? <div className="studio-reading-empty"><Icon name={mode === 'translation' ? 'translate' : 'waveform'} size={32} /><h2>{task.downloadBehavior === 'downloadOnly' ? '媒体已单独保存' : mode === 'translation' ? '还没有中文译文' : '文字正在路上'}</h2><p>{task.downloadBehavior === 'downloadOnly' ? '此任务只下载媒体。可以在下方打开文件或输出目录。' : mode === 'translation' ? task.translateToChinese ? '转写完成后将继续翻译，请稍候。' : '此任务没有启用中文翻译。' : active ? '你可以返回资料库添加其他任务，处理会继续进行。' : '该任务没有生成转写内容，请查看日志了解详情。'}</p></div> : segmented && rows.length ? <ol className="studio-reading-segments">{rows.filter((row) => mode === 'original' ? Boolean(row.original) : mode === 'translation' ? Boolean(row.translation) : true).map((row) => <li key={row.key}>{timestamps ? <time className="studio-segment-time">{formatTimestamp(row.start)} <span aria-hidden="true">—</span> {formatTimestamp(row.end)}</time> : null}<div className="studio-segment-copy">{mode !== 'translation' && row.original ? <p lang={task.language}><Highlight text={row.original} query={query} /></p> : null}{mode !== 'original' && row.translation ? <p lang="zh-CN" className={mode === 'bilingual' ? 'studio-translated-copy' : undefined}><Highlight text={row.translation} query={query} /></p> : null}</div></li>)}</ol> : <div className="studio-reading-prose">{mode === 'bilingual' ? <><section aria-label="转写原文"><h2>原文</h2><p lang={task.language}><Highlight text={original} query={query} /></p></section><section aria-label="中文译文"><h2>中文译文</h2><p lang="zh-CN"><Highlight text={translation || '此任务还没有中文译文。'} query={translation ? query : ''} /></p></section></> : <p lang={mode === 'translation' ? 'zh-CN' : task.language}><Highlight text={mode === 'translation' ? translation : original} query={query} /></p>}</div>}
        </div>
      </> : <article className="studio-history-summary"><Icon name="history" size={30} /><h2>这项任务已归档</h2><p>历史记录保留了任务摘要。完整文本、字幕和日志可在输出目录中查看。</p>{history?.outputDir ? <button className="studio-path-button" onClick={() => void workspace.revealPath(history.outputDir!)} type="button"><Icon name="folder" />{history.outputDir}</button> : <p>这条记录没有可用的输出目录。</p>}</article>}

      <section className="studio-record-files" aria-labelledby="studio-files-title"><header><h2 id="studio-files-title">文件与任务</h2><div className="studio-record-actions">
        <GlassButton disabled={!record.outputDir} onClick={() => { if (task) void workspace.openOutputDirectory(task.id); else if (record.outputDir) void workspace.revealPath(record.outputDir); }}><Icon name="folder" />打开输出目录</GlassButton>
        {task ? <GlassButton onClick={() => void workspace.openSourceLocation(task.id)}><Icon name="external" />定位媒体文件</GlassButton> : null}
        {sourceUrl ? <a className="studio-text-button" href={sourceUrl} target="_blank" rel="noopener noreferrer">访问原始链接<Icon name="external" size={15} /></a> : null}
      </div></header>
      {outputs.length ? <ul className="studio-output-files">{outputs.map(([kind, path]) => <li key={kind}><button onClick={() => void workspace.revealPath(path)} title={path} type="button"><Icon name={kind === 'audio' || kind === 'downloadedMedia' || kind === 'sourceMedia' ? 'waveform' : 'file'} /><span><strong>{outputLabels[kind]}</strong><small>{path.split(/[\\/]/).at(-1)}</small></span><Icon name="external" size={15} /></button></li>)}</ul> : null}
      <div className="studio-record-meta">{meta.map((label) => <span key={label}>{label}</span>)}{task && task.attempts > 1 ? <span>已重试 {task.attempts - 1} 次</span> : null}{history ? <span>结束于 {formatLongDateTime(history.finishedAt)}</span> : null}</div>
      <div className="studio-record-management" role="group" aria-label="管理任务">{task && ['failed', 'cancelled', 'partial'].includes(task.status) ? <button className="studio-text-button" onClick={() => void workspace.retryTask(task.id)} type="button"><Icon name="retry" />重新执行任务</button> : null}{task && active ? <button className="studio-text-button" onClick={() => void workspace.cancelTask(task.id)} type="button"><Icon name="stop" />取消任务</button> : null}{!active ? <button className="studio-text-button" disabled={removing} onClick={() => void removeRecord()} type="button"><Icon name="close" />{removing ? '正在移除…' : history ? '移除历史记录' : '移出当前任务'}</button> : null}<button className="studio-text-button studio-danger" disabled={!record.outputDir || active} onClick={() => workspace.requestDeleteTaskDirectory(record.id)} type="button"><Icon name="trash" />删除输出目录</button></div>
      </section>
    </section>
  );
}
