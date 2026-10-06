import { spawn } from 'node:child_process';

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const runProcess = (
  command: string,
  args: string[],
  options: ProcessOptions = {}
): Promise<ProcessResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: 'pipe'
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (!finished) {
            finished = true;
            void killProcessTree(child.pid).finally(() => {
              reject(new Error(`Process timeout after ${options.timeoutMs}ms`));
            });
          }
        }, options.timeoutMs)
      : undefined;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      if (!finished) {
        finished = true;
        reject(error);
      }
    });

    child.on('close', (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      if (!finished) {
        finished = true;
        resolve({ code, stdout, stderr });
      }
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
};

export const killProcessTree = async (pid?: number): Promise<void> => {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    await runProcess('taskkill', ['/pid', String(pid), '/T', '/F'], {
      timeoutMs: 5000
    }).catch(() => undefined);
    return;
  }

  process.kill(pid, 'SIGKILL');
};
