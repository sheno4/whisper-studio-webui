import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function detectHardware({ platform = process.platform, arch = process.arch, run = spawnSync, env = process.env } = {}) {
  const hardware = { platform, arch, memoryGB: os.totalmem() / 1024 ** 3, gpus: [] };
  const probe = (command, args) => run(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, env });
  const nvidia = probe('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (!nvidia.error && nvidia.status === 0) {
    hardware.gpus.push(...nvidia.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, memory] = line.split(',');
      return { vendor: 'nvidia', name: name.trim(), memoryMB: Number(memory) || undefined };
    }));
  }
  if (platform === 'win32') {
    const display = probe('powershell.exe', ['-NoProfile', '-Command', '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM) | ConvertTo-Json -Compress']);
    if (!display.error && display.status === 0) {
      try {
        const parsed = JSON.parse(display.stdout.trim());
        for (const gpu of Array.isArray(parsed) ? parsed : [parsed]) {
          const name = gpu.Name || '';
          const vendor = /AMD|Radeon/i.test(name) ? 'amd' : /Intel/i.test(name) ? 'intel' : /NVIDIA/i.test(name) ? 'nvidia' : 'other';
          if (!hardware.gpus.some((item) => item.vendor === vendor && item.name === name)) {
            hardware.gpus.push({ vendor, name, memoryMB: gpu.AdapterRAM ? gpu.AdapterRAM / 1024 ** 2 : undefined });
          }
        }
      } catch { /* Hardware detection is advisory; the CPU backend remains available. */ }
    }
  } else if (platform === 'linux') {
    try {
      for (const card of fs.readdirSync('/sys/class/drm').filter((name) => /^card\d+$/.test(name))) {
        const vendorId = fs.readFileSync(path.join('/sys/class/drm', card, 'device/vendor'), 'utf8').trim();
        const vendor = { '0x1002': 'amd', '0x8086': 'intel', '0x10de': 'nvidia' }[vendorId];
        if (vendor && !hardware.gpus.some((item) => item.vendor === vendor)) hardware.gpus.push({ vendor, name: `${vendor} (${card})` });
      }
    } catch { /* Headless hosts can have no DRM devices. */ }
  }
  return hardware;
}

export function chooseBackend(hardware, { cpu = false, backend } = {}) {
  if (backend) {
    if (!['faster-whisper', 'whisper', 'whisper.cpp'].includes(backend)) throw new Error(`Unsupported backend: ${backend}`);
    return backend;
  }
  if (hardware.platform === 'win32' && hardware.arch === 'arm64') return 'whisper.cpp';
  if (!cpu && !hardware.gpus.some((gpu) => gpu.vendor === 'nvidia') && hardware.gpus.some((gpu) => ['amd', 'intel'].includes(gpu.vendor))) return 'whisper.cpp';
  return 'faster-whisper';
}

export function chooseModel(hardware, cpu = false) {
  if (hardware.memoryGB < 8) return 'base';
  if (cpu || hardware.gpus.length === 0) return hardware.memoryGB >= 16 ? 'small' : 'base';
  const nvidia = hardware.gpus.find((gpu) => gpu.vendor === 'nvidia');
  if (nvidia?.memoryMB && nvidia.memoryMB < 4000) return 'small';
  if (!nvidia) {
    const memory = Math.max(...hardware.gpus.map((gpu) => gpu.memoryMB || 0));
    if (memory < 6000) return 'small';
  }
  return 'turbo';
}
