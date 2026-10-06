import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLocalPath, revealLocalPath } from '../src/main/system';

test('folder actions show the requested window and report launch failures', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-folder-actions-'));
  const file = path.join(directory, '中文 example.txt');
  await fs.writeFile(file, 'fixture');
  t.after(async () => { await fs.unlink(file); await fs.rmdir(directory); });
  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  let launchError: Error | undefined;
  t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    queueMicrotask(() => launchError ? child.emit('error', launchError) : child.emit('spawn'));
    return child;
  });

  assert.equal(await openLocalPath(directory), true);
  assert.equal(calls[0].options.windowsHide, false);
  assert.deepEqual(calls[0].args, [directory]);
  if (process.platform === 'win32') assert.ok(path.isAbsolute(calls[0].command));
  await revealLocalPath(file);
  if (process.platform === 'win32') assert.deepEqual(calls[1].args, ['/select,', file]);
  launchError = new Error('synthetic explorer launch failure');
  await assert.rejects(openLocalPath(directory), /explorer launch failure/);
  const previousCalls = calls.length;
  await assert.rejects(openLocalPath(path.join(directory, 'missing')), /不存在/);
  await assert.rejects(openLocalPath(''), /没有可打开/);
  assert.equal(calls.length, previousCalls);
});
