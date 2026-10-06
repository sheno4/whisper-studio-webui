import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../start-webui.sh', import.meta.url));
const shell = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'sh.exe')
  : '/bin/sh';
const shellPath = (value) => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
const msysPath = (value) => shellPath(value).replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const available = fs.existsSync(shell);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-posix-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(source, path.join(root, 'start-webui.sh'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'launch.mjs'), '// fixture only');
  const bin = path.join(root, 'fixture-bin');
  fs.mkdirSync(bin);
  const write = (name, contents) => {
    const target = path.join(bin, name);
    fs.writeFileSync(target, `#!/bin/sh\n${contents}\n`);
    fs.chmodSync(target, 0o755);
  };
  write('node', 'if [ "$1" = "-e" ]; then printf "probe\\n" >> "$WHISPER_NODE_PROBE_LOG"; exit 0; fi\nprintf "%s\\n" "$@" > "$WHISPER_NODE_ARGUMENT_LOG"\nexit 17');
  write('uname', 'if [ "$1" = "-s" ]; then printf "%s\\n" "${WHISPER_FIXTURE_OS:-Linux}"; else printf "x86_64\\n"; fi');
  write('curl', 'printf "download\\n" >> "$WHISPER_NODE_DOWNLOAD_LOG"\nexit 55');
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((name) => name.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = process.platform === 'win32' ? `${msysPath(bin)}:/usr/bin:/bin` : `${bin}${path.delimiter}${env[pathKey] || ''}`;
  env.WHISPER_NODE_PROBE_LOG = shellPath(path.join(root, 'probes.log'));
  env.WHISPER_NODE_ARGUMENT_LOG = shellPath(path.join(root, 'arguments.log'));
  env.WHISPER_NODE_DOWNLOAD_LOG = shellPath(path.join(root, 'downloads.log'));
  return { root, env };
}

test('Unix launcher forwards spaced arguments and preserves the Node exit status', { skip: !available }, (t) => {
  const { root, env } = fixture(t);
  const args = ['--setup-only', 'two words', '--model=tiny'];
  const result = spawnSync(shell, [shellPath(path.join(root, 'start-webui.sh')), ...args], {
    cwd: root, env: { ...env, WHISPER_PORTABLE_ONLY: '0' }, encoding: 'utf8', timeout: 20000, windowsHide: true
  });
  assert.equal(result.status, 17, result.stdout + result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(root, 'arguments.log'), 'utf8').trim().split('\n').slice(1), args);
  assert.equal(fs.readFileSync(path.join(root, 'probes.log'), 'utf8'), 'probe\n');
  assert.equal(fs.existsSync(path.join(root, 'downloads.log')), false);
});

test('Unix portable-only skips system Node and rejects a project Node without npm', { skip: !available }, (t) => {
  const { root, env } = fixture(t);
  const portable = process.platform === 'win32' ? path.join(root, '.runtime', 'node', 'node.exe') : path.join(root, '.runtime', 'node', 'bin', 'node');
  fs.mkdirSync(path.dirname(portable), { recursive: true });
  fs.copyFileSync(process.execPath, portable);
  fs.chmodSync(portable, 0o755);
  const result = spawnSync(shell, [shellPath(path.join(root, 'start-webui.sh')), '--setup-only'], {
    cwd: root, env: { ...env, WHISPER_PORTABLE_ONLY: '1' }, encoding: 'utf8', timeout: 20000, windowsHide: true
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Could not download Node\.js checksums/);
  assert.equal(fs.existsSync(path.join(root, 'probes.log')), false);
  assert.equal(fs.readFileSync(path.join(root, 'downloads.log'), 'utf8'), 'download\n');
  assert.equal(fs.existsSync(portable), true);
  assert.equal(fs.existsSync(path.join(root, '.runtime', 'node-bootstrap.lock')), false);
});

test('Linux-only launcher refuses Darwin before probing Node or creating a runtime directory', { skip: !available }, (t) => {
  const { root, env } = fixture(t);
  const result = spawnSync(shell, [shellPath(path.join(root, 'start-webui.sh')), '--setup-only'], {
    cwd: root, env: { ...env, WHISPER_FIXTURE_OS: 'Darwin' }, encoding: 'utf8', timeout: 10000, windowsHide: true
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /supports Windows and Linux/);
  assert.equal(fs.existsSync(path.join(root, 'probes.log')), false);
  assert.equal(fs.existsSync(path.join(root, 'downloads.log')), false);
  assert.equal(fs.existsSync(path.join(root, '.runtime')), false);
});
