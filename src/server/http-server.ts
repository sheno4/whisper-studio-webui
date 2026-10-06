import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import express, { type NextFunction, type Request, type Response } from 'express';

import type { ExportFileKind } from '../shared/types';
import { TaskManager } from '../main/task-manager';
import {
  getProjectRoot,
  getRendererIndexPath,
  getUploadsDir,
  getWallpapersDir
} from '../main/paths';
import {
  parseCreateTaskOptions,
  parseSaveSettings,
  parseStringArray,
  parseActiveTranslationService,
  parseTranslationService
} from './validation';

const exportKinds = new Set<ExportFileKind>([
  'transcriptTxt',
  'transcriptSrt',
  'transcriptVtt',
  'transcriptJson',
  'translationTxt',
  'translationSrt',
  'translationVtt',
  'translationJson'
]);

const mediaExtensions = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.flv', '.wmv', '.m4v', '.ts',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'
]);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif']);

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const parseCookies = (request: Request): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const part of (request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) {
      result[key] = decodeURIComponent(value);
    }
  }
  return result;
};

const sanitizeFilename = (value: string): string => {
  const base = path.basename(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  const extension = path.extname(base);
  const shortened = base.length > 180 && extension.length < 180
    ? base.slice(0, 180 - extension.length) + extension
    : base.slice(0, 180);
  return shortened || 'upload.bin';
};

const routeParam = (request: Request, name: string): string => {
  const value = request.params[name];
  return Array.isArray(value) ? value[0] || '' : value || '';
};

const isPathInside = (parent: string, child: string): boolean => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const createUploadLimiter = (maximumBytes: number): Transform => {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maximumBytes) {
        callback(Object.assign(
          new Error(`Upload exceeds the ${Math.round(maximumBytes / 1024 / 1024)} MB limit.`),
          { status: 413 }
        ));
        return;
      }
      callback(null, chunk);
    }
  });
};

const asyncRoute = (
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>
) => (request: Request, response: Response, next: NextFunction): void => {
  void handler(request, response, next).catch(next);
};

const sendSse = (response: Response, event: string, value: unknown): void => {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(value)}\n\n`);
};

export interface WebServerOptions {
  host: string;
  port: number;
  token?: string;
}

export const createWebServer = (taskManager: TaskManager, options: WebServerOptions) => {
  const app = express();
  const apiToken = options.token?.trim();
  const maximumUploadBytes = Math.max(
    1,
    Number(process.env.WHISPER_MAX_UPLOAD_MB || 10240)
  ) * 1024 * 1024;

  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.post('/api/session', (request, response) => {
    if (!apiToken) {
      response.json({ ok: true });
      return;
    }
    const submittedToken = typeof request.body?.token === 'string' ? request.body.token : '';
    if (!safeEqual(submittedToken, apiToken)) {
      response.status(401).json({ error: 'Invalid WebUI token.' });
      return;
    }
    response.setHeader(
      'Set-Cookie',
      `whisper_token=${encodeURIComponent(apiToken)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=86400`
    );
    response.json({ ok: true });
  });

  app.use('/api', (request, response, next) => {
    if (!apiToken) {
      next();
      return;
    }
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    const cookie = parseCookies(request).whisper_token || '';
    if ((bearer && safeEqual(bearer, apiToken)) || (cookie && safeEqual(cookie, apiToken))) {
      next();
      return;
    }
    response.status(401).json({ error: 'WebUI authentication is required.' });
  });

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, service: 'whisper-studio-webui' });
  });

  app.get('/api/snapshot', (_request, response) => {
    response.json(taskManager.getSnapshot());
  });

  app.get('/api/settings', (_request, response) => {
    response.json(taskManager.getSettings());
  });

  app.get('/api/events', (request, response) => {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    response.write('retry: 1500\n\n');
    sendSse(response, 'state', taskManager.getSnapshot());

    const offState = taskManager.onState((snapshot) => sendSse(response, 'state', snapshot));
    const offToast = taskManager.onToast((toast) => sendSse(response, 'toast', toast));
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
    request.on('close', () => {
      clearInterval(heartbeat);
      offState();
      offToast();
    });
  });

  app.post('/api/tasks/links', (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const links = parseStringArray(body.links, 'links');
    response.status(201).json(taskManager.addLinkTasks(links, parseCreateTaskOptions(body.options)));
  });

  app.post('/api/uploads', asyncRoute(async (request, response) => {
    const originalName = typeof request.query.name === 'string' ? request.query.name : '';
    const safeName = sanitizeFilename(originalName);
    const extension = path.extname(safeName).toLowerCase();
    if (!mediaExtensions.has(extension)) {
      response.status(415).json({ error: `Unsupported media extension: ${extension || '(none)'}` });
      return;
    }

    await fsPromises.mkdir(getUploadsDir(), { recursive: true });
    const targetPath = path.join(getUploadsDir(), `${randomUUID()}-${safeName}`);
    try {
      await pipeline(
        request,
        createUploadLimiter(maximumUploadBytes),
        fs.createWriteStream(targetPath, { flags: 'wx' })
      );
    } catch (error) {
      await fsPromises.rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
    response.status(201).json({ path: targetPath, name: safeName });
  }));

  app.post('/api/tasks/files', asyncRoute(async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const filePaths = parseStringArray(body.paths, 'paths');
    for (const filePath of filePaths) {
      if (!isPathInside(getUploadsDir(), filePath)) {
        response.status(400).json({ error: 'File path is outside the managed upload directory.' });
        return;
      }
      await fsPromises.access(filePath);
    }
    response.status(201).json(taskManager.addFileTasks(filePaths, parseCreateTaskOptions(body.options)));
  }));

  app.post('/api/tasks/:taskId/retry', asyncRoute(async (request, response) => {
    response.json({ ok: await taskManager.retryTask(routeParam(request, 'taskId')) });
  }));
  app.post('/api/tasks/:taskId/cancel', asyncRoute(async (request, response) => {
    response.json({ ok: await taskManager.cancelTask(routeParam(request, 'taskId')) });
  }));
  app.delete('/api/tasks/:taskId', asyncRoute(async (request, response) => {
    response.json({ ok: await taskManager.removeTask(routeParam(request, 'taskId')) });
  }));
  app.delete('/api/tasks/:taskId/output', asyncRoute(async (request, response) => {
    response.json({ ok: await taskManager.deleteTaskDirectory(routeParam(request, 'taskId')) });
  }));
  app.post('/api/tasks/:taskId/open-output', asyncRoute(async (request, response) => {
    response.json({ ok: await taskManager.openOutputDir(routeParam(request, 'taskId')) });
  }));
  app.post('/api/tasks/:taskId/open-source', asyncRoute(async (request, response) => {
    response.json({ ok: await taskManager.openSourceLocation(routeParam(request, 'taskId')) });
  }));

  app.get('/api/tasks/:taskId/files/:kind', asyncRoute(async (request, response) => {
    const kind = routeParam(request, 'kind') as ExportFileKind;
    if (!exportKinds.has(kind)) {
      response.status(400).json({ error: 'Unknown export file type.' });
      return;
    }
    const filePath = taskManager.getTaskFilePath(routeParam(request, 'taskId'), kind);
    if (!filePath) {
      response.status(404).json({ error: 'Export file was not found.' });
      return;
    }
    await fsPromises.access(filePath);
    // These paths come from known task artifacts. Their parent directories may
    // legitimately start with a dot (for example a configured .outputs folder).
    response.download(filePath, path.basename(filePath), { dotfiles: 'allow' });
  }));

  app.post('/api/reveal', asyncRoute(async (request, response) => {
    const targetPath = typeof request.body?.path === 'string' ? request.body.path : '';
    response.json({ ok: await taskManager.revealPath(targetPath) });
  }));

  app.post('/api/settings', asyncRoute(async (request, response) => {
    response.json(await taskManager.saveSettings(parseSaveSettings(request.body)));
  }));
  app.post('/api/models/prepare', (_request, response) => {
    response.status(202).json(taskManager.prepareModel());
  });
  app.post('/api/models/:id/cancel', (request, response) => {
    response.json({ ok: taskManager.cancelModelPreparation(routeParam(request, 'id')) });
  });
  app.post('/api/settings/translation-service', asyncRoute(async (request, response) => {
    response.json(await taskManager.setActiveTranslationService(parseActiveTranslationService(request.body)));
  }));
  app.post('/api/settings/translation-service/test', asyncRoute(async (request, response) => {
    response.json(await taskManager.testTranslationService(parseTranslationService(request.body)));
  }));

  app.delete('/api/history', asyncRoute(async (_request, response) => {
    await taskManager.clearHistory();
    response.json({ ok: true });
  }));
  app.delete('/api/history/:historyId', asyncRoute(async (request, response) => {
    response.json({ ok: await taskManager.removeHistoryItem(routeParam(request, 'historyId')) });
  }));

  app.post('/api/wallpapers', asyncRoute(async (request, response) => {
    const originalName = typeof request.query.name === 'string' ? request.query.name : '';
    const safeName = sanitizeFilename(originalName);
    const extension = path.extname(safeName).toLowerCase();
    if (!imageExtensions.has(extension)) {
      response.status(415).json({ error: `Unsupported image extension: ${extension || '(none)'}` });
      return;
    }
    await fsPromises.mkdir(getWallpapersDir(), { recursive: true });
    const fileName = `${randomUUID()}${extension}`;
    const targetPath = path.join(getWallpapersDir(), fileName);
    try {
      await pipeline(request, createUploadLimiter(50 * 1024 * 1024), fs.createWriteStream(targetPath, { flags: 'wx' }));
    } catch (error) {
      await fsPromises.rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
    response.status(201).json({ path: `/api/wallpapers/${fileName}` });
  }));

  app.get('/api/wallpapers/:fileName', asyncRoute(async (request, response) => {
    const fileName = path.basename(routeParam(request, 'fileName'));
    const targetPath = path.join(getWallpapersDir(), fileName);
    if (!isPathInside(getWallpapersDir(), targetPath)) {
      response.status(400).end();
      return;
    }
    await fsPromises.access(targetPath);
    // The default storage is .data/wallpapers, which sendFile otherwise ignores.
    response.sendFile(targetPath, { dotfiles: 'allow' });
  }));

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'API route not found.' });
  });

  const rendererIndex = getRendererIndexPath();
  const rendererDir = path.dirname(rendererIndex);
  if (fs.existsSync(rendererIndex)) {
    app.use(express.static(rendererDir, { index: false }));
    app.get(/.*/, (_request, response) => response.sendFile(rendererIndex, { dotfiles: 'allow' }));
  } else {
    app.get('/', (_request, response) => {
      response.status(503).type('text/plain').send('Web assets are missing. Run npm run build or use npm run dev.');
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    const detail = error as { status?: unknown; code?: unknown } | null;
    const status = typeof detail?.status === 'number' && Number.isInteger(detail.status)
      && detail.status >= 400 && detail.status <= 599
      ? detail.status
      : detail?.code === 'ENOENT' ? 404 : 500;
    if (status >= 500) console.error(error);
    if (!response.headersSent) {
      response.status(status).json({ error: message || 'Internal server error.' });
    }
  });

  return app.listen(options.port, options.host, () => {
    console.log(`Whisper Studio WebUI: http://${options.host}:${options.port}`);
    console.log(`Project root: ${getProjectRoot()}`);
  });
};
