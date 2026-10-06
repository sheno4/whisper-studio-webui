import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function runtimeDirectory(root) {
  const resolvedRoot = fs.realpathSync(root);
  const runtime = path.join(resolvedRoot, '.runtime');
  fs.mkdirSync(runtime, { recursive: true });
  if (fs.realpathSync(runtime) !== runtime) throw new Error('The .runtime directory must stay inside this project.');
  return runtime;
}

export function readBootstrapState(root) {
  try { return JSON.parse(fs.readFileSync(path.join(runtimeDirectory(root), 'bootstrap-state.json'), 'utf8')); }
  catch { return {}; }
}

export function saveBootstrapState(root, patch) {
  const target = path.join(runtimeDirectory(root), 'bootstrap-state.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...readBootstrapState(root), ...patch }, null, 2));
  fs.renameSync(temporary, target);
}

export function fingerprint(root, files, extra = '') {
  const hash = createHash('sha256').update(extra);
  for (const name of [...files].sort()) {
    hash.update(name);
    hash.update(fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name)) : 'missing');
  }
  return hash.digest('hex');
}

export function buildFingerprint(root) {
  const files = ['package.json', 'package-lock.json', 'index.html', 'vite.config.mts', 'tsconfig.json', 'tsconfig.server.json', 'scripts/runtime-env.cjs'];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files.push(name);
    }
  };
  visit('src');
  return fingerprint(root, files, `${process.platform}:${process.arch}:${process.versions.node.split('.')[0]}`);
}

export async function withSetupLock(root, operation) {
  const lock = path.join(runtimeDirectory(root), 'setup.lock');
  const token = randomUUID();
  const deadline = Date.now() + 20 * 60_000;
  let notified = false;
  while (true) {
    try {
      const handle = fs.openSync(lock, 'wx');
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(handle);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* An owner may still be writing. */ }
      if (owner?.pid) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (failure) { alive = failure.code !== 'ESRCH'; }
        if (!alive) { try { fs.unlinkSync(lock); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; } continue; }
      } else {
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.unlinkSync(lock); continue; }
        } catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
      }
      if (Date.now() > deadline) throw new Error('Another window is still installing dependencies. Close that installer or wait for it to finish.');
      if (!notified) { console.log('Another window is preparing this project. Waiting for it to finish...'); notified = true; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try { return await operation(); }
  finally {
    try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).token === token) fs.unlinkSync(lock); } catch { /* Preserve another owner's lock. */ }
  }
}
