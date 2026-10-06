import fs from 'node:fs/promises';
import path from 'node:path';

import type { LogLevel } from '../shared/types';
import { getDataDir } from './paths';

const getLogFilePath = (): string => {
  return path.join(getDataDir(), 'logs', 'whisper-studio.log');
};

export const writeAppLog = async (
  level: LogLevel,
  message: string,
  context?: string
): Promise<void> => {
  const target = getLogFilePath();
  await fs.mkdir(path.dirname(target), { recursive: true });

  const line = [
    `[${new Date().toISOString()}]`,
    `[${level.toUpperCase()}]`,
    context ? `[${context}]` : '',
    message
  ]
    .filter(Boolean)
    .join(' ');

  await fs.appendFile(target, `${line}\n`, 'utf8');
};
