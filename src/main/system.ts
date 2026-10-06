import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const spawnDetached = (command: string, args: string[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      // This process is the window the user explicitly asked to open.
      windowsHide: false
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};

const resolveExistingPath = async (targetPath: string): Promise<string> => {
  if (!targetPath.trim()) throw new Error('没有可打开的目录或文件。');
  const resolved = path.resolve(targetPath);
  try {
    await fs.access(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw Object.assign(new Error(`目录或文件不存在：${resolved}`), { code: 'ENOENT' });
    }
    throw error;
  }
  return resolved;
};

const explorerPath = (): string => path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');

export const openLocalPath = async (targetPath: string): Promise<boolean> => {
  const resolved = await resolveExistingPath(targetPath);

  if (process.platform === 'win32') {
    await spawnDetached(explorerPath(), [resolved]);
  } else if (process.platform === 'darwin') {
    await spawnDetached('open', [resolved]);
  } else {
    await spawnDetached('xdg-open', [resolved]);
  }

  return true;
};

export const revealLocalPath = async (targetPath: string): Promise<boolean> => {
  const resolved = await resolveExistingPath(targetPath);
  const stat = await fs.stat(resolved);

  if (process.platform === 'win32') {
    await spawnDetached(explorerPath(), stat.isDirectory() ? [resolved] : ['/select,', resolved]);
  } else if (process.platform === 'darwin') {
    await spawnDetached('open', stat.isDirectory() ? [resolved] : ['-R', resolved]);
  } else {
    await spawnDetached('xdg-open', [stat.isDirectory() ? resolved : path.dirname(resolved)]);
  }

  return true;
};
