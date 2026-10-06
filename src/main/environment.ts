import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRuntimeEnv } from '../../scripts/runtime-env.cjs';

import type { EnvironmentStatus, SettingsData } from '../shared/types';
import { getProjectRoot, getWorkerScriptPath } from './paths';
import { runProcess } from './process';

interface WorkerEnvCheck {
  pythonVersion?: string;
  whisperOk: boolean;
  fasterWhisperOk?: boolean;
  ytDlpOk: boolean;
  ffmpegOk: boolean;
  ffmpegVersion?: string;
  whisperPath?: string;
  fasterWhisperPath?: string;
  ytDlpVersion?: string;
}

export async function probeOutputDirectory(outputDir: string): Promise<void> {
  await fsPromises.mkdir(outputDir, { recursive: true });
  const probePath = path.join(outputDir, `.whisper-write-probe-${randomUUID()}`);
  const handle = await fsPromises.open(probePath, 'wx');
  try {
    await handle.writeFile('write check');
  } finally {
    await handle.close();
    await fsPromises.unlink(probePath);
  }
}

function parseWorkerCheck(stdout: string): WorkerEnvCheck | null {
  try {
    return JSON.parse(stdout) as WorkerEnvCheck;
  } catch {
    return null;
  }
}

function getTranscriptionEngineCheck(settings: SettingsData, workerCheck: WorkerEnvCheck | null): {
  ok: boolean;
  details: string;
} {
  if (!workerCheck) {
    return { ok: false, details: 'Not checked because the Python environment check did not complete.' };
  }

  if (settings.transcriptionEngine === 'faster-whisper') {
    return {
      ok: workerCheck?.fasterWhisperOk ?? false,
      details: workerCheck?.fasterWhisperPath ?? 'faster-whisper is not available in the selected Python environment.'
    };
  }

  return {
    ok: workerCheck?.whisperOk ?? false,
    details: workerCheck?.whisperPath ?? 'openai-whisper is not available in the selected Python environment.'
  };
}

export async function runEnvironmentCheck(
  settings: SettingsData,
  runCommand: typeof runProcess = runProcess
): Promise<EnvironmentStatus> {
  const checkedAt = new Date().toISOString();
  const items: EnvironmentStatus['items'] = [];
  const pythonEnv = {
    ...getRuntimeEnv(getProjectRoot()),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  };

  let pythonError = '';
  const [pythonProbe, ffmpegProbe] = await Promise.all([
    runCommand(settings.pythonPath, ['--version'], {
      env: pythonEnv,
      timeoutMs: 10000
    }).catch((error) => {
      pythonError = error instanceof Error ? error.message : String(error);
      return null;
    }),
    // FFmpeg is an independent executable and can be checked even if Python fails.
    runCommand('ffmpeg', ['-version'], { env: pythonEnv, timeoutMs: 10000 }).catch(() => null)
  ]);
  const pythonExists = Boolean(pythonProbe && pythonProbe.code === 0);
  items.push({
    key: 'python',
    label: 'Python',
    ok: pythonExists,
    details: pythonExists
      ? `${settings.pythonPath} | ${(pythonProbe?.stdout || pythonProbe?.stderr || '').trim()}`
      : `Could not start ${settings.pythonPath}. ${pythonProbe?.stderr.trim() || pythonError}`.trim(),
    suggestion: pythonExists
      ? 'The WebUI will reuse this Python environment.'
      : 'Run npm run setup, or set WHISPER_PYTHON_PATH to a valid interpreter.'
  });

  let workerCheck: WorkerEnvCheck | null = null;
  if (pythonExists) {
    const result = await runCommand(
      settings.pythonPath,
      ['-X', 'utf8', getWorkerScriptPath(), 'env-check'],
      {
        env: pythonEnv,
        timeoutMs: 30000
      }
    ).catch((error) => {
      items.push({
        key: 'python_worker',
        label: 'Python worker',
        ok: false,
        details: error instanceof Error ? error.message : 'The Python worker failed to start.',
        suggestion: 'Verify that the selected Python environment can import the transcription dependencies.'
      });
      return null;
    });

    if (result) {
      workerCheck = result.code === 0 ? parseWorkerCheck(result.stdout.trim()) : null;
      if (!workerCheck) {
        items.push({
          key: 'python_worker',
          label: 'Python worker',
          ok: false,
          details: result.stderr.trim() || 'The environment check returned unreadable output.',
          suggestion: 'Open .data/logs/whisper-studio.log and inspect the Python worker output.'
        });
      }
    }
  }

  const transcriptionEngine = getTranscriptionEngineCheck(settings, workerCheck);
  items.push({
    key: 'transcription_engine',
    label: 'Transcription engine',
    ok: transcriptionEngine.ok,
    details: `${settings.transcriptionEngine}: ${transcriptionEngine.details}`,
    suggestion: transcriptionEngine.ok
      ? 'The selected transcription backend is ready.'
      : workerCheck
        ? 'Install the selected transcription backend in the configured Python environment.'
        : 'Fix the Python environment first, then run the check again.'
  });

  items.push({
    key: 'yt_dlp',
    label: 'yt-dlp',
    ok: workerCheck?.ytDlpOk ?? false,
    details: workerCheck
      ? workerCheck.ytDlpVersion ? `yt-dlp ${workerCheck.ytDlpVersion}` : 'yt-dlp is not available.'
      : 'Not checked because the Python environment check did not complete.',
    suggestion: workerCheck
      ? workerCheck.ytDlpOk ? 'Link download support is ready.' : 'Install yt-dlp in the Python environment.'
      : 'Fix the Python environment first, then run the check again.'
  });

  const ffmpegOk = ffmpegProbe?.code === 0;
  items.push({
    key: 'ffmpeg',
    label: 'FFmpeg',
    ok: ffmpegOk,
    details: ffmpegOk
      ? (ffmpegProbe.stdout || ffmpegProbe.stderr).trim().split(/\r?\n/)[0]
      : ffmpegProbe?.stderr.trim() || 'FFmpeg could not be started from PATH.',
    suggestion: ffmpegOk ? 'Audio extraction support is ready.' : 'Install FFmpeg or add it to PATH.'
  });

  const outputDirOk = await probeOutputDirectory(settings.outputDir)
    .then(() => true)
    .catch(() => false);

  items.push({
    key: 'output_dir',
    label: 'Output folder',
    ok: outputDirOk,
    details: settings.outputDir,
    suggestion: outputDirOk ? 'The output folder is writable.' : 'Choose a folder that the app can write to.'
  });

  const activeService = settings.translationServices.find(
    (service) => service.id === settings.activeTranslationServiceId && service.enabled
  );
  items.push({
    key: 'translation_provider',
    label: 'Translation service',
    ok: Boolean(activeService),
    details: activeService
      ? `${activeService.name} | ${activeService.model} | ${activeService.apiUrl}`
      : 'No custom translation service is active.',
    suggestion: activeService
      ? 'The custom translation service configuration is ready.'
      : 'Add and enable a custom translation service in Settings.'
  });

  items.push({
    key: 'translation_api_key',
    label: 'Translation API key (optional)',
    ok: true,
    details: activeService?.apiKeyConfigured
      ? 'Stored securely on this machine.'
      : 'No key is stored; anonymous and free endpoints can still be used.',
    suggestion: 'Only add a key when your custom endpoint requires one.'
  });

  return {
    checkedAt,
    items,
    apiKeyConfigured: Boolean(activeService?.apiKeyConfigured)
  };
}
