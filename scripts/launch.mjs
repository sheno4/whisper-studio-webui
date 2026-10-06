import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canRunPython, getVenvPython } from './python-runtime.mjs';
import { getRuntimeEnv } from './runtime-env.cjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
Object.assign(process.env, getRuntimeEnv(projectRoot));
const args = new Set(process.argv.slice(2));
const forceBuild = args.has('--rebuild');
const noBrowser = args.has('--no-browser');
const skipSetup = args.has('--skip-setup');
const npmCliPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

const runNpm = (npmArgs) => {
  const useNodeNpm = fs.existsSync(npmCliPath);
  const result = spawnSync(
    useNodeNpm ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    useNodeNpm ? [npmCliPath, ...npmArgs] : npmArgs,
    {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32' && !useNodeNpm
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm ${npmArgs.join(' ')} exited with code ${String(result.status)}.`);
  }
};

const nodeModulesDir = path.join(projectRoot, 'node_modules');
if (!fs.existsSync(nodeModulesDir)) {
  console.log('Node dependencies are missing. Running npm install...');
  runNpm(['install']);
}

try {
  const { config } = await import('dotenv');
  config({ path: path.join(projectRoot, '.env'), quiet: true });
} catch {
  // The server will report a clearer dependency error if dotenv is unavailable.
}

const venvPython = getVenvPython(projectRoot);

if (!skipSetup && !process.env.WHISPER_PYTHON_PATH?.trim() && !canRunPython(venvPython)) {
  console.log('Python environment is missing or cannot start. Running npm run setup...');
  runNpm(['run', 'setup']);
}

const rendererEntry = path.join(projectRoot, 'dist', 'index.html');
const serverEntry = path.join(projectRoot, 'dist-server', 'server', 'index.js');
if (forceBuild || !fs.existsSync(rendererEntry) || !fs.existsSync(serverEntry)) {
  console.log('Production build is missing. Running npm run build...');
  runNpm(['run', 'build']);
}

const configuredHost = process.env.WHISPER_HOST?.trim() || '127.0.0.1';
const browserHost = configuredHost === '0.0.0.0' || configuredHost === '::'
  ? '127.0.0.1'
  : configuredHost;
const formattedHost = browserHost.includes(':') ? `[${browserHost}]` : browserHost;
const port = process.env.WHISPER_PORT?.trim() || '4317';
const baseUrl = `http://${formattedHost}:${port}`;
const token = process.env.WHISPER_WEB_TOKEN?.trim();
const browserUrl = token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : `${baseUrl}/`;

const openBrowser = (url) => {
  let command;
  let commandArgs;

  if (process.platform === 'win32') {
    command = 'rundll32.exe';
    commandArgs = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    commandArgs = [url];
  } else {
    command = 'xdg-open';
    commandArgs = [url];
  }

  const opener = spawn(command, commandArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  opener.unref();
};

const waitForServer = async () => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The server may still be starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out while waiting for ${baseUrl}.`);
};

console.log(`Starting Whisper Studio at ${baseUrl}`);
console.log('Keep this window open. Close it or press Ctrl+C to stop the entire project.');

try {
  // Run the HTTP server in this launcher process. This deliberately ties the
  // WebUI lifetime to the command window instead of leaving an orphaned child.
  await import(pathToFileURL(serverEntry).href);
  await waitForServer();
  console.log(`WebUI is ready: ${baseUrl}`);
  if (!noBrowser) {
    openBrowser(browserUrl);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
