import 'dotenv/config';

import { TaskManager } from '../main/task-manager';
import { createWebServer } from './http-server';

const host = process.env.WHISPER_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.WHISPER_PORT || 4317);
const token = process.env.WHISPER_WEB_TOKEN?.trim();
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('WHISPER_PORT must be a valid TCP port.');
}

if (!loopbackHosts.has(host) && !token && process.env.WHISPER_ALLOW_UNAUTHENTICATED !== 'true') {
  throw new Error(
    'WHISPER_WEB_TOKEN is required when binding outside localhost. ' +
    'Set a strong token, or explicitly set WHISPER_ALLOW_UNAUTHENTICATED=true.'
  );
}

const main = async (): Promise<void> => {
  const taskManager = new TaskManager();
  const server = createWebServer(taskManager, { host, port, token });
  let isShuttingDown = false;
  void taskManager.initialize().catch((error) => {
    console.error('Environment initialization failed:', error);
  });

  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    server.close();
    await taskManager.shutdown();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGHUP', () => void shutdown());
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
