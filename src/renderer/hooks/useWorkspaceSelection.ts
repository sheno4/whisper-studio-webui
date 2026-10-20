import { useCallback, useEffect, useRef, useState } from 'react';

import type { AppSnapshot, HistoryRecord, TaskRecord } from '../../shared/types';
import { isTaskActive } from '../utils';

export type ActivityView = 'queue' | 'history';

interface WorkspaceSelectionController {
  activityView: ActivityView;
  selectedTaskId?: string;
  selectedHistoryId?: string;
  selectedTask?: TaskRecord;
  selectedHistoryRecord?: HistoryRecord;
  activeTask?: TaskRecord;
  activeHistoryRecord?: HistoryRecord;
  historyResultLoading: boolean;
  historyResultError?: string;
  reloadHistoryResult: () => void;
  setActivityView: (value: ActivityView) => void;
  setSelectedTaskId: (value: string) => void;
  setSelectedHistoryId: (value: string) => void;
  focusCreatedTasks: (created: TaskRecord[]) => void;
}

function adjacentSelection(previous: string[], current: string[], removedId?: string): string | undefined {
  const index = removedId ? previous.indexOf(removedId) : -1;
  if (index < 0) return undefined;
  const available = new Set(current);
  return previous.slice(index + 1).find(id => available.has(id))
    ?? previous.slice(0, index).reverse().find(id => available.has(id));
}

export function useWorkspaceSelection(snapshot: AppSnapshot | null): WorkspaceSelectionController {
  const [activityView, setActivityView] = useState<ActivityView>('queue');
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedHistoryId, setSelectedHistoryId] = useState<string>();
  const pendingCreatedTaskId = useRef<string | undefined>(undefined);
  const previousTasks = useRef<string[]>([]);
  const previousHistory = useRef<string[]>([]);
  const results = useRef(new Map<string, TaskRecord>());
  const [result, setResult] = useState<{ key: string; task?: TaskRecord; error?: string }>({ key: '' });
  const [resultAttempt, setResultAttempt] = useState(0);

  useEffect(() => {
    if (!snapshot) return;
    const previous = previousTasks.current;
    previousTasks.current = snapshot.tasks.map(task => task.id);
    if (pendingCreatedTaskId.current !== undefined && pendingCreatedTaskId.current === selectedTaskId) {
      if (!snapshot?.tasks.some((task) => task.id === selectedTaskId)) {
        return;
      }
      pendingCreatedTaskId.current = undefined;
    }
    if (!snapshot || snapshot.tasks.some((task) => task.id === selectedTaskId)) {
      return;
    }

    const nextTaskId = adjacentSelection(previous, previousTasks.current, selectedTaskId)
      ?? snapshot.tasks.find(isTaskActive)?.id ?? snapshot.tasks.at(-1)?.id;
    setSelectedTaskId(nextTaskId);
  }, [selectedTaskId, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const previous = previousHistory.current;
    previousHistory.current = snapshot.history.map(record => record.id);
    if (!snapshot || snapshot.history.some((record) => record.id === selectedHistoryId)) {
      return;
    }

    setSelectedHistoryId(adjacentSelection(previous, previousHistory.current, selectedHistoryId) ?? snapshot.history[0]?.id);
  }, [selectedHistoryId, snapshot]);

  const selectedTask = snapshot?.tasks.find((task) => task.id === selectedTaskId);
  const selectedHistoryRecord = snapshot?.history.find((record) => record.id === selectedHistoryId);
  const selectedHistoryTask = snapshot?.tasks.find((task) => task.id === selectedHistoryId);
  const activeHistoryRecord = activityView === 'history' ? selectedHistoryRecord : undefined;
  const historyKey = activeHistoryRecord ? JSON.stringify([activeHistoryRecord.id, activeHistoryRecord.finishedAt, activeHistoryRecord.status, activeHistoryRecord.outputDir, activeHistoryRecord.error]) : '';
  // A retried task reuses its ID. History must retain the last finished result,
  // rather than displaying that task's new, unfinished run.
  const finishedLiveResult = activeHistoryRecord && selectedHistoryTask && !isTaskActive(selectedHistoryTask) && selectedHistoryTask.updatedAt === activeHistoryRecord.finishedAt ? selectedHistoryTask : undefined;
  const historyTask = historyKey ? results.current.get(historyKey) ?? (result.key === historyKey ? result.task : undefined) ?? finishedLiveResult : undefined;
  const historyResultError = !historyTask && result.key === historyKey ? result.error : undefined;
  const historyResultLoading = Boolean(historyKey && !historyTask && !historyResultError);
  const activeTask = activityView === 'queue' ? selectedTask : historyTask;

  useEffect(() => {
    if (!historyKey || !activeHistoryRecord) return;
    const cached = results.current.get(historyKey);
    if (cached) { setResult({ key: historyKey, task: cached }); return; }
    let current = true;
    setResult({ key: historyKey });
    void window.whisperWeb.getHistoryResult(activeHistoryRecord.id).then(task => {
      if (!current) return;
      if (task.id !== activeHistoryRecord.id) throw new Error('读取到的结果与所选历史记录不一致，请重新读取。');
      results.current.set(historyKey, task);
      while (results.current.size > 8) results.current.delete(results.current.keys().next().value!);
      setResult({ key: historyKey, task });
    }).catch(cause => {
      if (current) setResult({ key: historyKey, error: cause instanceof Error ? cause.message : '无法读取任务结果，请重试。' });
    });
    return () => { current = false; };
  }, [historyKey, resultAttempt]);

  useEffect(() => {
    // Removed history entries must not survive in the local result cache.
    const ids = new Set(snapshot?.history.map(record => record.id));
    for (const [key, task] of results.current) if (!ids.has(task.id)) results.current.delete(key);
  }, [snapshot?.history]);
  const reloadHistoryResult = useCallback((): void => {
    results.current.delete(historyKey);
    setResult({ key: historyKey });
    setResultAttempt(attempt => attempt + 1);
  }, [historyKey]);

  const focusCreatedTasks = useCallback((created: TaskRecord[]): void => {
    setActivityView('queue');
    if (created[0]) {
      pendingCreatedTaskId.current = created[0].id;
      setSelectedTaskId(created[0].id);
    }
  }, []);

  return {
    activityView,
    selectedTaskId,
    selectedHistoryId,
    selectedTask,
    selectedHistoryRecord,
    activeTask,
    activeHistoryRecord,
    historyResultLoading,
    historyResultError,
    reloadHistoryResult,
    setActivityView,
    setSelectedTaskId,
    setSelectedHistoryId,
    focusCreatedTasks
  };
}
