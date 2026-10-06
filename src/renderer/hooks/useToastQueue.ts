import { useCallback, useEffect, useRef, useState } from 'react';

import type { ToastEvent } from '../../shared/types';

interface ToastQueueController {
  toasts: ToastEvent[];
  pushToast: (toast: Omit<ToastEvent, 'id'>, durationMs?: number) => void;
}

const DESKTOP_TOAST_DURATION_MS = 3200;
const LOCAL_TOAST_DURATION_MS = 2800;

export function useToastQueue(): ToastQueueController {
  const [toasts, setToasts] = useState<ToastEvent[]>([]);
  const toastTimers = useRef(new Map<string, number>());

  const enqueueToast = useCallback((toast: ToastEvent, durationMs = DESKTOP_TOAST_DURATION_MS): void => {
    setToasts((current) => [...current.filter((item) => item.id !== toast.id), toast]);

    const existingTimer = toastTimers.current.get(toast.id);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== toast.id));
      toastTimers.current.delete(toast.id);
    }, durationMs);

    toastTimers.current.set(toast.id, timer);
  }, []);

  const pushToast = useCallback(
    (toast: Omit<ToastEvent, 'id'>, durationMs = LOCAL_TOAST_DURATION_MS): void => {
      enqueueToast({ ...toast, id: crypto.randomUUID() }, durationMs);
    },
    [enqueueToast]
  );

  useEffect(() => {
    return window.whisperWeb.onToast(enqueueToast);
  }, [enqueueToast]);

  useEffect(() => {
    const timers = toastTimers.current;

    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  return { toasts, pushToast };
}
