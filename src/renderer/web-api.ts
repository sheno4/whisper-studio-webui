import type { WhisperWebApi } from '../shared/api';
import type { AppSnapshot, ToastEvent } from '../shared/types';

const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const tokenQuery = new URLSearchParams(window.location.search).get('token');
if (tokenQuery) {
  window.sessionStorage.setItem('whisper-web-token', tokenQuery);
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete('token');
  window.history.replaceState({}, '', cleanUrl);
}
const token = tokenQuery || window.sessionStorage.getItem('whisper-web-token') || '';

const apiUrl = (pathname: string): string => `${apiBase}${pathname}`;

let sessionReady: Promise<void> | undefined;
const ensureSession = (): Promise<void> => {
  if (!token) {
    return Promise.resolve();
  }
  sessionReady ??= fetch(apiUrl('/api/session'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    }).then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || 'WebUI authentication failed.');
      }
    }).catch((error) => {
      sessionReady = undefined;
      throw error;
    });
  return sessionReady;
};

const request = async <T>(pathname: string, init?: RequestInit): Promise<T> => {
  await ensureSession();
  connectEvents();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (init?.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(apiUrl(pathname), {
    ...init,
    credentials: 'same-origin',
    headers
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
};

const chooseFiles = (accept: string, multiple: boolean): Promise<File[]> => {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    const finish = (): void => {
      resolve(Array.from(input.files || []));
      input.remove();
    };
    input.addEventListener('change', finish, { once: true });
    input.addEventListener('cancel', finish, { once: true });
    document.body.append(input);
    input.click();
  });
};

const uploadFile = async (file: File, endpoint = '/api/uploads'): Promise<string> => {
  await ensureSession();
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(apiUrl(`${endpoint}?name=${encodeURIComponent(file.name)}`), {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: file
  });
  const payload = await response.json().catch(() => ({})) as { path?: string; error?: string };
  if (!response.ok || !payload.path) {
    throw new Error(payload.error || `Upload failed with HTTP ${response.status}.`);
  }
  return payload.path;
};

const uploadFiles = async (files: object[]): Promise<string[]> => {
  const mediaFiles = files.filter((file): file is File => file instanceof File);
  const paths: Array<string | undefined> = new Array(mediaFiles.length);
  const failures: Array<string | undefined> = new Array(mediaFiles.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < mediaFiles.length) {
      const index = cursor;
      cursor += 1;
      try {
        paths[index] = await uploadFile(mediaFiles[index]);
      } catch (error) {
        failures[index] = `${mediaFiles[index].name}：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(2, mediaFiles.length) }, () => worker()));
  const uploadedPaths = paths.filter((value): value is string => Boolean(value));
  const failedFiles = failures.filter((value): value is string => Boolean(value));
  if (failedFiles.length > 0) {
    const details = failedFiles.join('\n');
    if (uploadedPaths.length === 0) {
      throw new Error(`所有文件上传失败。\n${details}`);
    }
    const toast: ToastEvent = {
      id: crypto.randomUUID(),
      title: '部分文件上传失败',
      message: `已上传 ${uploadedPaths.length} 个文件，将继续创建任务；${failedFiles.length} 个失败，请重新选择失败的文件。\n${details}`,
      tone: 'warning'
    };
    for (const listener of toastListeners) {
      listener(toast);
    }
  }
  return uploadedPaths;
};

const stateListeners = new Set<(snapshot: AppSnapshot) => void>();
const toastListeners = new Set<(toast: ToastEvent) => void>();
let eventSource: EventSource | undefined;

const connectEvents = (): void => {
  if (eventSource) {
    return;
  }
  void ensureSession().then(() => {
    if (eventSource || (stateListeners.size === 0 && toastListeners.size === 0)) {
      return;
    }
    eventSource = new EventSource(apiUrl('/api/events'), { withCredentials: true });
    eventSource.addEventListener('state', (event) => {
      const snapshot = JSON.parse((event as MessageEvent<string>).data) as AppSnapshot;
      for (const listener of stateListeners) {
        listener(snapshot);
      }
    });
    eventSource.addEventListener('toast', (event) => {
      const toast = JSON.parse((event as MessageEvent<string>).data) as ToastEvent;
      for (const listener of toastListeners) {
        listener(toast);
      }
    });
  }).catch(() => {
    // The snapshot request reports authentication/network failures. A later
    // retry will establish the session and reconnect these existing listeners.
  });
};

const disconnectEventsIfUnused = (): void => {
  if (stateListeners.size === 0 && toastListeners.size === 0) {
    eventSource?.close();
    eventSource = undefined;
  }
};

const api: WhisperWebApi = {
  getSnapshot: () => request('/api/snapshot'),
  getSettings: () => request('/api/settings'),
  uploadFiles,
  addLinkTasks: (links, options) => request('/api/tasks/links', {
    method: 'POST',
    body: JSON.stringify({ links, options })
  }),
  addFileTasks: (paths, options) => request('/api/tasks/files', {
    method: 'POST',
    body: JSON.stringify({ paths, options })
  }),
  retryTask: async (taskId) => (await request<{ ok: boolean }>(`/api/tasks/${taskId}/retry`, { method: 'POST' })).ok,
  cancelTask: async (taskId) => (await request<{ ok: boolean }>(`/api/tasks/${taskId}/cancel`, { method: 'POST' })).ok,
  removeTask: async (taskId) => (await request<{ ok: boolean }>(`/api/tasks/${taskId}`, { method: 'DELETE' })).ok,
  deleteTaskDirectory: async (taskId) => (await request<{ ok: boolean }>(`/api/tasks/${taskId}/output`, { method: 'DELETE' })).ok,
  openOutputDir: async (taskId) => (await request<{ ok: boolean }>(`/api/tasks/${taskId}/open-output`, { method: 'POST' })).ok,
  openSourceLocation: async (taskId) => (await request<{ ok: boolean }>(`/api/tasks/${taskId}/open-source`, { method: 'POST' })).ok,
  exportTaskFile: async (taskId, kind) => {
    await ensureSession();
    const headers = new Headers();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const response = await fetch(apiUrl(`/api/tasks/${taskId}/files/${kind}`), {
      credentials: 'same-origin',
      headers
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `文件导出失败（HTTP ${response.status}）。`);
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const encodedFilename = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const filename = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
    let downloadName = filename?.[1] || filename?.[2]?.trim() || `${kind}.${kind.replace(/^(transcript|translation)/, '').toLowerCase()}`;
    if (encodedFilename) {
      try {
        downloadName = decodeURIComponent(encodedFilename);
      } catch {
        // Keep the plain filename when the server sent malformed encoding.
      }
    }
    const downloadUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = downloadName;
    try {
      document.body.append(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    }
    return true;
  },
  pickFiles: async () => uploadFiles(await chooseFiles('audio/*,video/*,.mkv,.flac,.m4a,.webm', true)),
  pickWallpaperFile: async () => {
    const [file] = await chooseFiles('image/*', false);
    return file ? uploadFile(file, '/api/wallpapers') : null;
  },
  pickDirectory: async () => window.prompt('请输入运行 WebUI 的机器上的输出目录路径：'),
  saveSettings: (payload) => request('/api/settings', { method: 'POST', body: JSON.stringify(payload) }),
  setActiveTranslationService: (serviceId) => request('/api/settings/translation-service', {
    method: 'POST',
    body: JSON.stringify({ serviceId })
  }),
  testTranslationService: (service) => request('/api/settings/translation-service/test', {
    method: 'POST',
    body: JSON.stringify(service)
  }),
  clearHistory: () => request('/api/history', { method: 'DELETE' }).then(() => undefined),
  removeHistoryItem: async (historyId) => (await request<{ ok: boolean }>(`/api/history/${historyId}`, { method: 'DELETE' })).ok,
  revealPath: async (targetPath) => (await request<{ ok: boolean }>('/api/reveal', {
    method: 'POST',
    body: JSON.stringify({ path: targetPath })
  })).ok,
  onState: (listener) => {
    stateListeners.add(listener);
    connectEvents();
    return () => {
      stateListeners.delete(listener);
      disconnectEventsIfUnused();
    };
  },
  onToast: (listener) => {
    toastListeners.add(listener);
    connectEvents();
    return () => {
      toastListeners.delete(listener);
      disconnectEventsIfUnused();
    };
  }
};

window.whisperWeb = api;
