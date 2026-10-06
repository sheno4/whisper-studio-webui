import { useCallback, useEffect, useRef, useState } from 'react';

import type { AppSnapshot, TaskRecord } from '../../shared/types';

interface DesktopSnapshotController {
  snapshot: AppSnapshot | null;
  loadError?: string;
  reload: () => Promise<void>;
  includeCreatedTasks: (created: TaskRecord[]) => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function includeMissingTasks(snapshot: AppSnapshot, created: TaskRecord[]): AppSnapshot {
  const knownIds = new Set(snapshot.tasks.map((task) => task.id));
  const missing = created.filter((task) => {
    if (knownIds.has(task.id)) {
      return false;
    }
    knownIds.add(task.id);
    return true;
  });
  return missing.length > 0 ? { ...snapshot, tasks: [...snapshot.tasks, ...missing] } : snapshot;
}

function includeUnconfirmedTasks(snapshot: AppSnapshot, pending: Map<string, TaskRecord>): AppSnapshot {
  for (const task of snapshot.tasks) {
    pending.delete(task.id);
  }
  return includeMissingTasks(snapshot, [...pending.values()]);
}

export function useDesktopSnapshot(
  onSnapshotLoaded?: (snapshot: AppSnapshot) => void
): DesktopSnapshotController {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const stateRevision = useRef(0);
  const requestRevision = useRef(0);
  const snapshotLoaded = useRef(false);
  const serverTaskIds = useRef(new Set<string>());
  const pendingCreatedTasks = useRef(new Map<string, TaskRecord>());

  const reload = useCallback(async (): Promise<void> => {
    const revision = stateRevision.current;
    const request = ++requestRevision.current;
    setLoadError(undefined);

    try {
      let nextSnapshot = await window.whisperWeb.getSnapshot();
      if (revision !== stateRevision.current || request !== requestRevision.current) {
        return;
      }
      serverTaskIds.current = new Set(nextSnapshot.tasks.map((task) => task.id));
      nextSnapshot = includeUnconfirmedTasks(nextSnapshot, pendingCreatedTasks.current);
      snapshotLoaded.current = true;
      setSnapshot(nextSnapshot);
      onSnapshotLoaded?.(nextSnapshot);
    } catch (error) {
      if (revision === stateRevision.current && request === requestRevision.current) {
        setLoadError(getErrorMessage(error));
      }
    }
  }, [onSnapshotLoaded]);

  const includeCreatedTasks = useCallback((created: TaskRecord[]): void => {
    if (created.length === 0) {
      return;
    }
    stateRevision.current += 1;
    for (const task of created) {
      if (!serverTaskIds.current.has(task.id)) {
        pendingCreatedTasks.current.set(task.id, task);
      }
    }
    setSnapshot((current) => current ? includeMissingTasks(current, created) : current);
    if (!snapshotLoaded.current) {
      void reload();
    }
  }, [reload]);

  useEffect(() => {
    const unsubscribe = window.whisperWeb.onState((streamedSnapshot) => {
      stateRevision.current += 1;
      serverTaskIds.current = new Set(streamedSnapshot.tasks.map((task) => task.id));
      const nextSnapshot = includeUnconfirmedTasks(streamedSnapshot, pendingCreatedTasks.current);
      snapshotLoaded.current = true;
      setSnapshot(nextSnapshot);
      setLoadError(undefined);
      onSnapshotLoaded?.(nextSnapshot);
    });
    void reload();
    return () => {
      requestRevision.current += 1;
      unsubscribe();
    };
  }, [onSnapshotLoaded, reload]);

  return { snapshot, loadError, reload, includeCreatedTasks };
}
