import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getRuntimeEnv } from './runtime-env.cjs';
import { setupProject, setupOptions, loadProjectEnv } from './setup.mjs';
import { buildFingerprint, fingerprint, readBootstrapState, saveBootstrapState, withSetupLock } from './bootstrap-state.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function findNpmCli(nodePath = process.execPath) {
  const directory = path.dirname(nodePath);
  return [
    path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
    '/usr/lib/node_modules/npm/bin/npm-cli.js'
  ].find((file) => fs.existsSync(file));
}

export function nodeDependenciesReady(root) {
  try {
    const require = createRequire(path.join(root, 'package.json'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (!fs.existsSync(path.join(root, 'node_modules', name, 'package.json'))) return false;
      if (!name.startsWith('@types/')) require.resolve(name);
    }
    return ['vite/bin/vite.js', 'typescript/bin/tsc'].every((file) => fs.existsSync(path.join(root, 'node_modules', file)));
  } catch { return false; }
}

export async function prepareLaunch(root = projectRoot, options = {}) {
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('The automatic launcher supports Windows and Linux.');
  let env = getRuntimeEnv(root, options.env || process.env);
  const runNpm = options.runNpm || ((npmArgs) => {
    const npmCli = findNpmCli();
    if (!npmCli) throw new Error('The Node.js installation has no npm CLI. Run start-webui.bat or sh start-webui.sh to prepare a complete Node.js runtime.');
    const result = spawnSync(process.execPath, [npmCli, ...npmArgs], { cwd: root, env, stdio: 'inherit', shell: false, windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm ${npmArgs[0]} failed (${String(result.status)}). Run the launcher again after correcting the reported error.`);
  });
  return withSetupLock(root, async () => {
    const nodeKey = fingerprint(root, ['package.json', 'package-lock.json'], `${process.platform}:${process.arch}:${process.versions.node.split('.')[0]}`);
    const dependencyProbe = options.nodeDependenciesReady || nodeDependenciesReady;
    if (options.repair || readBootstrapState(root).nodeKey !== nodeKey || !dependencyProbe(root)) {
      console.log('Preparing Node.js dependencies...');
      const modules = path.join(fs.realpathSync(root), 'node_modules');
      if (fs.existsSync(modules) && path.relative(modules, fs.realpathSync(modules)) !== '') throw new Error('node_modules points outside its installation directory; remove that link before installing.');
      runNpm([fs.existsSync(path.join(root, 'package-lock.json')) ? 'ci' : 'install', '--include=dev', '--no-audit', '--no-fund']);
      if (!dependencyProbe(root)) throw new Error('The Node.js dependency installation is incomplete. Run the launcher again.');
      saveBootstrapState(root, { nodeKey });
    }
    let configuration;
    if (!options.skipSetup) configuration = await (options.setupProject || setupProject)(root, { ...options, env });
    if (configuration) {
      env = getRuntimeEnv(root, env);
      if (configuration.browserPath) env.WHISPER_CHROMIUM_PATH = configuration.browserPath;
      if (configuration.cppPath) env.WHISPER_CPP_PATH = configuration.cppPath;
      if (configuration.cpu) env.WHISPER_DEVICE = 'cpu';
      if (configuration.pythonLibraryDirs?.length) env.LD_LIBRARY_PATH = [...new Set([...configuration.pythonLibraryDirs, ...(env.LD_LIBRARY_PATH || '').split(':').filter(Boolean)])].join(':');
    }
    const buildKey = buildFingerprint(root);
    const entries = [path.join(root, 'dist', 'index.html'), path.join(root, 'dist-server', 'server', 'index.js')];
    if (options.rebuild || readBootstrapState(root).buildKey !== buildKey || entries.some((file) => !fs.existsSync(file))) {
      // npm clean must never traverse a user-provided junction outside the checkout.
      const realRoot = fs.realpathSync(root);
      for (const name of ['dist', 'dist-server']) {
        const directory = path.join(realRoot, name);
        if (fs.existsSync(directory) && path.relative(directory, fs.realpathSync(directory)) !== '') throw new Error(`${name} points outside the project; remove that link before building.`);
      }
      console.log('Building the current application source...');
      runNpm(['run', 'build']);
      if (entries.some((file) => !fs.existsSync(file))) throw new Error('The application build did not produce both WebUI and server entries.');
      saveBootstrapState(root, { buildKey });
    }
    return { env, configuration };
  });
}

async function startServer(root, env, noBrowser) {
  Object.assign(process.env, env);
  const configuredHost = env.WHISPER_HOST?.trim() || '127.0.0.1';
  const browserHost = ['0.0.0.0', '::'].includes(configuredHost) ? '127.0.0.1' : configuredHost;
  const baseUrl = `http://${browserHost.includes(':') ? `[${browserHost}]` : browserHost}:${env.WHISPER_PORT?.trim() || '4317'}`;
  const token = env.WHISPER_WEB_TOKEN?.trim();
  console.log(`Starting Whisper Studio at ${baseUrl}`);
  console.log('Keep this window open. Close it or press Ctrl+C to stop the project.');
  await import(pathToFileURL(path.join(root, 'dist-server', 'server', 'index.js')).href);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the HTTP listener. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Timed out waiting for ${baseUrl}.`);
  console.log(`WebUI is ready: ${baseUrl}`);
  if (!noBrowser) {
    const url = token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : `${baseUrl}/`;
    const command = process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    opener.once('error', () => console.warn(`Could not open a browser automatically. Open ${baseUrl} manually.`));
    opener.unref();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    loadProjectEnv(projectRoot);
    const args = process.argv.slice(2);
    const options = { ...setupOptions(args), rebuild: args.includes('--rebuild'), skipSetup: args.includes('--skip-setup') };
    const { env } = await prepareLaunch(projectRoot, options);
    if (args.includes('--setup-only')) console.log('Setup and build complete. Run the launcher again to open the WebUI.');
    else await startServer(projectRoot, env, args.includes('--no-browser'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
