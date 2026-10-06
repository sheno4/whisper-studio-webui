import fs from 'node:fs';
import path from 'node:path';

export const getProjectRoot = (): string => {
  return path.resolve(__dirname, '..', '..');
};

export const getWorkerScriptPath = (): string => {
  return path.join(getProjectRoot(), 'python', 'worker.py');
};

export const getDataDir = (): string => {
  return path.resolve(process.env.WHISPER_DATA_DIR?.trim() || path.join(getProjectRoot(), '.data'));
};

export const getRendererIndexPath = (): string => {
  return path.join(getProjectRoot(), 'dist', 'index.html');
};

export const getUploadsDir = (): string => {
  return path.join(getDataDir(), 'uploads');
};

export const getWallpapersDir = (): string => {
  return path.join(getDataDir(), 'wallpapers');
};

export const getDefaultPythonPath = (): string => {
  const configured = process.env.WHISPER_PYTHON_PATH?.trim();
  if (configured) {
    return configured;
  }

  const virtualEnvironmentPython = path.join(
    getProjectRoot(),
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python'
  );

  if (fs.existsSync(virtualEnvironmentPython)) {
    return virtualEnvironmentPython;
  }

  return process.platform === 'win32' ? 'python' : 'python3';
};

export const getDefaultOutputDir = (): string => {
  return path.resolve(process.env.WHISPER_OUTPUT_DIR?.trim() || path.join(getProjectRoot(), 'outputs'));
};

export const resolveStoredRuntimePaths = (stored: {
  pythonPath?: string;
  outputDir?: string;
}): { pythonPath: string; outputDir: string } => {
  let pythonPath = stored.pythonPath?.trim() || getDefaultPythonPath();
  let outputDir = stored.outputDir?.trim() || getDefaultOutputDir();
  const projectRoot = getProjectRoot();
  const venvSuffix = path.join(
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python'
  );
  const localPython = path.join(projectRoot, venvSuffix);

  if (path.isAbsolute(pythonPath) && !fs.existsSync(pythonPath) && fs.existsSync(localPython)) {
    const previousRoot = path.resolve(path.dirname(pythonPath), '..', '..');
    // Recover the default paths of a moved checkout, but keep custom interpreters
    // and output folders. An old output folder may have been recreated by a check.
    if (
      path.relative(path.join(previousRoot, venvSuffix), pythonPath) === '' &&
      path.basename(previousRoot).toLowerCase() === path.basename(projectRoot).toLowerCase()
    ) {
      pythonPath = localPython;
      if (path.isAbsolute(outputDir) && path.relative(path.join(previousRoot, 'outputs'), outputDir) === '') {
        outputDir = getDefaultOutputDir();
      }
    }
  }

  return {
    pythonPath: process.env.WHISPER_PYTHON_PATH?.trim() || pythonPath,
    outputDir: process.env.WHISPER_OUTPUT_DIR?.trim() ? getDefaultOutputDir() : outputDir
  };
};
