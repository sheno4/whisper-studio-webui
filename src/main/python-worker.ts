import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type { WorkerEvent, WorkerResultPayload, WorkerTaskRequest } from '../shared/types';
import { killProcessTree } from './process';

export interface PythonWorkerOptions {
  pythonPath: string;
  workerScriptPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class PythonWorkerCancelledError extends Error {
  readonly code = 'task_cancelled';

  constructor() {
    super('Task cancelled');
    this.name = 'CancelledTaskError';
  }
}

interface WorkerSession {
  child: ChildProcessWithoutNullStreams;
  configuration: string;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  lineBuffer: string;
}

interface PendingRequest {
  request: WorkerTaskRequest;
  onEvent: (event: WorkerEvent) => void;
  resolve: (result: WorkerResultPayload) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timeout?: NodeJS.Timeout;
  session?: WorkerSession;
}

const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const workerError = (message: string, code: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

/** A single serialized Python worker. Use separate clients for parallel jobs. */
export class PythonWorkerClient {
  private session?: WorkerSession;
  private pending?: PendingRequest;
  private disposed = false;
  private readonly stopping = new Set<Promise<void>>();

  constructor(private readonly defaultOptions?: PythonWorkerOptions) {}

  get isBusy(): boolean {
    return Boolean(this.pending);
  }

  run(
    request: WorkerTaskRequest,
    onEvent: (event: WorkerEvent) => void,
    signal?: AbortSignal,
    options: PythonWorkerOptions | undefined = this.defaultOptions
  ): Promise<WorkerResultPayload> {
    if (this.disposed) {
      return Promise.reject(workerError('Python worker client has been shut down', 'worker_shutdown'));
    }
    if (this.pending) {
      return Promise.reject(workerError('Python worker client is already busy', 'worker_busy'));
    }
    if (signal?.aborted) {
      return Promise.reject(new PythonWorkerCancelledError());
    }
    if (!options?.pythonPath || !options.workerScriptPath) {
      return Promise.reject(workerError('Python worker paths are required', 'worker_configuration'));
    }

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { request, onEvent, resolve, reject, signal };
      this.pending = pending;
      pending.onAbort = () => this.fail(pending, new PythonWorkerCancelledError());
      signal?.addEventListener('abort', pending.onAbort, { once: true });
      // Check again after installing the listener, before starting any process.
      if (signal?.aborted) {
        pending.onAbort();
        return;
      }

      const configuredTimeout = options.timeoutMs ?? Number(process.env.WHISPER_WORKER_TIMEOUT_MS);
      const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_TIMEOUT_MS;
      pending.timeout = setTimeout(() => {
        this.fail(pending, workerError(`Python worker timed out after ${timeoutMs}ms`, 'worker_timeout'));
      }, timeoutMs);

      void this.startRequest(pending, options).catch((error: unknown) => this.fail(pending, error));
    });
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    if (this.pending) {
      this.fail(this.pending, workerError('Python worker client has been shut down', 'worker_shutdown'));
    }
    this.invalidateSession(this.session);
    await Promise.all(this.stopping);
  }

  private async startRequest(pending: PendingRequest, options: PythonWorkerOptions): Promise<void> {
    const env = { ...(options.env ?? process.env), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    const configuration = JSON.stringify([
      options.pythonPath,
      options.workerScriptPath,
      Object.entries(env).sort(([left], [right]) => left.localeCompare(right))
    ]);
    if (this.session && (
      this.session.configuration !== configuration ||
      this.session.child.exitCode !== null ||
      this.session.child.signalCode !== null
    )) {
      const stop = this.invalidateSession(this.session);
      await stop;
    }
    if (this.pending !== pending || this.disposed) return;

    let session = this.session;
    if (!session) {
      const child = spawn(options.pythonPath, ['-X', 'utf8', options.workerScriptPath, 'serve'], {
        env,
        windowsHide: true,
        stdio: 'pipe'
      });
      session = {
        child,
        configuration,
        stdoutDecoder: new StringDecoder('utf8'),
        stderrDecoder: new StringDecoder('utf8'),
        lineBuffer: ''
      };
      this.session = session;
      const current = session;
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.session !== current) return;
        current.lineBuffer += current.stdoutDecoder.write(chunk);
        this.drainLines(current);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (this.session === current) this.handleStderr(current, current.stderrDecoder.write(chunk));
      });
      child.stdin.on('error', (error: Error) => this.failSession(current, error));
      child.on('error', (error: Error) => this.failSession(current, error));
      child.on('close', (code: number | null) => {
        if (this.session !== current) return;
        current.lineBuffer += current.stdoutDecoder.end();
        this.drainLines(current, true);
        this.handleStderr(current, current.stderrDecoder.end());
        this.failSession(current, workerError(
          `Python worker exited unexpectedly with code ${String(code)}`,
          'worker_exit'
        ));
      });
    }
    pending.session = session;
    const current = session;
    current.child.stdin.write(`${JSON.stringify(pending.request)}\n`, (error) => {
      if (error && this.session === current && this.pending === pending) this.fail(pending, error);
    });
  }

  private drainLines(session: WorkerSession, flush = false): void {
    const lines = session.lineBuffer.split(/\r?\n/);
    session.lineBuffer = flush ? '' : lines.pop() ?? '';
    for (const line of lines) {
      if (this.session !== session) return;
      const pending = this.pending;
      if (!pending || pending.session !== session || !line.trim()) continue;
      let event: WorkerEvent;
      try {
        event = JSON.parse(line.trim()) as WorkerEvent;
      } catch {
        this.emit(pending, {
          type: 'log', level: 'warning', message: `Unparsed worker output: ${line.trim().slice(0, 240)}`
        });
        continue;
      }
      if (!event || !['log', 'progress', 'metadata', 'error', 'result'].includes(event.type)) {
        this.emit(pending, { type: 'log', level: 'warning', message: 'Unknown Python worker event' });
        continue;
      }
      if (event.type === 'result' && event.data?.taskId !== pending.request.taskId) {
        this.fail(pending, workerError('Python worker returned a result for another task', 'worker_protocol'));
        return;
      }
      if (!this.emit(pending, event)) return;
      if (event.type === 'error') {
        this.fail(pending, workerError(event.message, event.code));
        return;
      }
      if (event.type === 'result') {
        this.clearPending(pending);
        pending.resolve(event.data);
      }
    }
  }

  private handleStderr(session: WorkerSession, message: string): void {
    const pending = this.pending;
    if (pending?.session === session && message.trim()) {
      this.emit(pending, { type: 'log', level: 'warning', message: message.trim(), context: 'stderr' });
    }
  }

  private emit(pending: PendingRequest, event: WorkerEvent): boolean {
    try {
      pending.onEvent(event);
      return this.pending === pending;
    } catch (error) {
      this.fail(pending, error);
      return false;
    }
  }

  private clearPending(pending: PendingRequest): void {
    if (this.pending !== pending) return;
    this.pending = undefined;
    if (pending.timeout) clearTimeout(pending.timeout);
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort);
  }

  private fail(pending: PendingRequest, error: unknown): void {
    if (this.pending !== pending) return;
    this.clearPending(pending);
    this.invalidateSession(pending.session);
    pending.reject(error);
  }

  private failSession(session: WorkerSession, error: unknown): void {
    if (this.session !== session) return;
    if (this.pending?.session === session) this.fail(this.pending, error);
    else this.invalidateSession(session);
  }

  private invalidateSession(session?: WorkerSession): Promise<void> | undefined {
    if (!session || this.session !== session) return undefined;
    this.session = undefined;
    const stop = killProcessTree(session.child.pid).catch(() => undefined);
    this.stopping.add(stop);
    void stop.finally(() => this.stopping.delete(stop));
    return stop;
  }
}
