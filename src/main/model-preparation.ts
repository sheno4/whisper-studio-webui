import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { getRuntimeEnv } from '../../scripts/runtime-env.cjs';

import type { ModelPreparationState, SettingsData, TranscriptionEngine } from '../shared/types';
import { killProcessTree } from './process';

export interface ModelPreparationRequest {
  projectRoot: string;
  pythonPath: string;
  engine: TranscriptionEngine;
  model: string;
}

export interface ModelPreparationProgress {
  message: string;
  percent?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface ModelPreparationResult { path: string; pythonLibraryDirs?: string[]; }

export type ModelPreparationRunner = (
  request: ModelPreparationRequest,
  onProgress: (event: ModelPreparationProgress) => void,
  signal: AbortSignal
) => Promise<string | ModelPreparationResult>;

const cancelled = (): Error & { code: string } => Object.assign(new Error('模型准备已取消。'), { code: 'model_preparation_cancelled' });

export const runModelPreparation: ModelPreparationRunner = (request, onProgress, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(cancelled()); return; }
  const child = spawn(process.execPath, [path.join(request.projectRoot, 'scripts', 'model-runtime.mjs')], {
    cwd: request.projectRoot,
    env: { ...getRuntimeEnv(request.projectRoot), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe'
  });
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let resultPath: string | undefined;
  let pythonLibraryDirs: string[] = [];
  let failure: Error | undefined;
  let settled = false;
  const onAbort = (): void => { void killProcessTree(child.pid).catch(() => child.kill()); };
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    failure = new Error('模型准备超时，请检查网络后重试。');
    onAbort();
  }, 6 * 60 * 60 * 1000);
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) reject(cancelled());
    else if (error || failure) reject(error || failure);
    else if (resultPath) resolve({ path: resultPath, pythonLibraryDirs });
    else reject(new Error('模型准备未返回有效结果，请重试。'));
  };
  const consume = (line: string): void => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'result' && typeof event.path === 'string') {
        resultPath = event.path;
        if (Array.isArray(event.pythonLibraryDirs)) pythonLibraryDirs = event.pythonLibraryDirs.filter((item): item is string => typeof item === 'string' && path.isAbsolute(item) && !item.includes('\0'));
      }
      else if (event.type === 'error') failure = Object.assign(new Error(typeof event.message === 'string' ? event.message : '模型准备失败。'), { code: event.code });
      else if (event.type === 'progress' && typeof event.message === 'string') {
        const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
        try { onProgress({ message: event.message.slice(0, 1024), percent: number(event.percent), downloadedBytes: number(event.downloadedBytes), totalBytes: number(event.totalBytes) }); }
        catch { /* A notification failure must not invalidate the download protocol. */ }
      }
    } catch { failure = new Error('模型准备进程返回了无效数据。'); }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    pending += decoder.write(chunk);
    if (pending.length > 2 * 1024 * 1024) { failure = new Error('模型准备进程返回了过量数据。'); onAbort(); return; }
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  });
  // Child diagnostics are not protocol messages, and may contain private URLs.
  child.stderr.resume();
  child.stdin.on('error', (error) => { failure = error; });
  child.on('error', finish);
  child.on('close', (code) => {
    pending += decoder.end();
    consume(pending);
    finish(code !== 0 && !failure ? new Error(`模型准备进程退出（${String(code)}），请检查运行环境后重试。`) : undefined);
  });
  child.stdin.end(JSON.stringify(request));
  if (signal.aborted) onAbort();
});

interface Job {
  state: ModelPreparationState;
  controller: AbortController;
  promise: Promise<string>;
  modelPath?: string;
  pythonPath: string;
  reject: (error: unknown) => void;
  resolve: (modelPath: string) => void;
  request: ModelPreparationRequest;
  pythonLibraryDirs?: string[];
}

function usableModelPath(modelPath: string | undefined): boolean {
  if (!modelPath) return false;
  try {
    const stat = fs.statSync(modelPath);
    if (stat.isFile()) return stat.size > 0;
    if (!stat.isDirectory()) return false;
    return ['model.bin', 'config.json'].every((name) => {
      const entry = fs.statSync(path.join(modelPath, name));
      return entry.isFile() && entry.size > 0;
    });
  } catch { return false; }
}

export class ModelPreparationManager {
  private readonly jobs = new Map<string, Job>();
  private pending: Job[] = [];
  private readonly running = new Set<Promise<void>>();
  private readonly maxConcurrent: number;
  private disposed = false;

  constructor(private readonly options: { projectRoot: string; onChange: () => void; run?: ModelPreparationRunner; maxConcurrent?: number }) {
    this.maxConcurrent = Number.isFinite(options.maxConcurrent) ? Math.max(1, Math.floor(options.maxConcurrent!)) : 2;
  }

  private notify(): void {
    try { this.options.onChange(); }
    catch { /* UI observers cannot interrupt scheduling or resource cleanup. */ }
  }

  private schedule(): void {
    while (!this.disposed && this.running.size < this.maxConcurrent && this.pending.length) {
      const job = this.pending.shift()!;
      if (job.controller.signal.aborted) continue;
      // Register the slot before running callbacks. A callback can enqueue
      // another model, but cannot bypass the concurrency limit.
      const execution = Promise.resolve().then(() => this.runJob(job));
      this.running.add(execution);
      void execution.finally(() => {
        this.running.delete(execution);
        this.schedule();
      });
    }
  }

  private async runJob(job: Job): Promise<void> {
    const { state, controller } = job;
    try {
      if (this.disposed || controller.signal.aborted) throw cancelled();
      state.status = 'preparing'; state.message = '正在检查运行环境和模型缓存';
      this.notify();
      const result = await (this.options.run || runModelPreparation)(job.request, (event) => {
        if (controller.signal.aborted) return;
        Object.assign(state, event);
        if (state.percent !== undefined) state.percent = Math.min(100, state.percent);
        this.notify();
      }, controller.signal);
      if (controller.signal.aborted) throw cancelled();
      job.modelPath = typeof result === 'string' ? result : result.path;
      if (!usableModelPath(job.modelPath)) throw new Error('模型缓存缺少完整权重或配置，请在模型准备面板重试。');
      job.pythonLibraryDirs = typeof result === 'string' ? [] : result.pythonLibraryDirs;
      state.status = 'ready'; state.percent = 100; state.message = '模型已就绪，可直接转写';
      job.resolve(job.modelPath!);
    } catch (error) {
      state.status = controller.signal.aborted || this.disposed ? 'cancelled' : 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      state.message = state.status === 'cancelled' ? '模型准备已取消，可随时重试' : state.error;
      job.reject(error);
    } finally { this.notify(); }
  }

  getStates(): ModelPreparationState[] { return [...this.jobs.values()].map((job) => ({ ...job.state })); }

  getPythonLibraryDirs(pythonPath: string): string[] {
    return [...new Set([...this.jobs.values()].filter((job) => job.pythonPath === pythonPath && job.state.status === 'ready').flatMap((job) => job.pythonLibraryDirs || []))];
  }

  prepare(settings: Pick<SettingsData, 'pythonPath' | 'transcriptionEngine' | 'whisperModel'>, retry = false): Job {
    if (this.disposed) throw cancelled();
    const model = settings.transcriptionEngine === 'whisper.cpp'
      ? (({ turbo: 'large-v3-turbo', large: 'large-v3' } as Record<string, string>)[settings.whisperModel] || settings.whisperModel)
      : settings.whisperModel;
    const key = JSON.stringify([settings.pythonPath, settings.transcriptionEngine, model]);
    const previous = this.jobs.get(key);
    if (previous && (['queued', 'preparing'].includes(previous.state.status) ||
      (previous.state.status === 'ready' && usableModelPath(previous.modelPath)) ||
      (!retry && ['failed', 'cancelled'].includes(previous.state.status)))) return previous;
    const state: ModelPreparationState = { id: randomUUID(), pythonPath: settings.pythonPath, engine: settings.transcriptionEngine, model, status: 'queued', message: '正在等待模型准备资源' };
    const controller = new AbortController();
    let resolve!: (modelPath: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
    // Preparation runs in the background; task waiters still receive failures.
    void promise.catch(() => undefined);
    const job: Job = { state, controller, promise, pythonPath: settings.pythonPath, reject, resolve,
      request: { projectRoot: this.options.projectRoot, pythonPath: settings.pythonPath, engine: settings.transcriptionEngine, model } };
    this.jobs.set(key, job);
    this.pending.push(job);
    this.notify();
    this.schedule();
    return job;
  }

  async waitFor(settings: Pick<SettingsData, 'pythonPath' | 'transcriptionEngine' | 'whisperModel'>, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw cancelled();
    const job = this.prepare(settings);
    if (!signal) return job.promise;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(cancelled());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void job.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  cancel(id: string): boolean {
    const job = [...this.jobs.values()].find((candidate) => candidate.state.id === id);
    if (!job || !['queued', 'preparing'].includes(job.state.status)) return false;
    job.controller.abort();
    job.reject(cancelled());
    job.state.status = 'cancelled'; job.state.message = '模型准备已取消，可随时重试';
    this.pending = this.pending.filter((candidate) => candidate !== job);
    this.notify();
    this.schedule();
    return true;
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    for (const job of this.jobs.values()) {
      if (['queued', 'preparing'].includes(job.state.status)) {
        job.controller.abort(); job.reject(cancelled());
        job.state.status = 'cancelled'; job.state.message = '模型准备已取消，可随时重试';
      }
    }
    this.pending = [];
    this.notify();
    // Job promises reject immediately on cancellation. Runner promises settle
    // only after their processes close, so shutdown waits for actual cleanup.
    await Promise.allSettled([...this.running]);
  }
}
