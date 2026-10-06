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
  setActivityView: (value: ActivityView) => void;
  setSelectedTaskId: (value: string) => void;
  setSelectedHistoryId: (value: string) => void;
  focusCreatedTasks: (created: TaskRecord[]) => void;
}

export function useWorkspaceSelection(snapshot: AppSnapshot | null): WorkspaceSelectionController {
  const [activityView, setActivityView] = useState<ActivityView>('queue');
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedHistoryId, setSelectedHistoryId] = useState<string>();
  const pendingCreatedTaskId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (pendingCreatedTaskId.current !== undefined && pendingCreatedTaskId.current === selectedTaskId) {
      if (!snapshot?.tasks.some((task) => task.id === selectedTaskId)) {
        return;
      }
      pendingCreatedTaskId.current = undefined;
    }
    if (!snapshot || snapshot.tasks.some((task) => task.id === selectedTaskId)) {
      return;
    }

    const nextTaskId = snapshot.tasks.find(isTaskActive)?.id ?? snapshot.tasks.at(-1)?.id;
    setSelectedTaskId(nextTaskId);
  }, [selectedTaskId, snapshot]);

  useEffect(() => {
    if (!snapshot || snapshot.history.some((record) => record.id === selectedHistoryId)) {
      return;
    }

    setSelectedHistoryId(snapshot.history[0]?.id);
  }, [selectedHistoryId, snapshot]);

  const selectedTask = snapshot?.tasks.find((task) => task.id === selectedTaskId);
  const selectedHistoryRecord = snapshot?.history.find((record) => record.id === selectedHistoryId);
  const selectedHistoryTask = snapshot?.tasks.find((task) => task.id === selectedHistoryId);
  const activeTask = activityView === 'queue' ? selectedTask : selectedHistoryTask;
  const activeHistoryRecord = activityView === 'history' ? selectedHistoryRecord : undefined;

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
    setActivityView,
    setSelectedTaskId,
    setSelectedHistoryId,
    focusCreatedTasks
  };
}
