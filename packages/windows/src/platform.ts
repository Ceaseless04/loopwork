import type { Platform } from './types.js';

export function detectPlatform(
  env: Record<string, string | undefined>,
  fs: { exists(p: string): boolean; readFile(p: string): string | undefined },
  platform: string = process.platform,
): Platform {
  if (platform === 'win32' || platform === 'darwin') return platform;
  const procVersion = fs.exists('/proc/version') ? fs.readFile('/proc/version') : undefined;
  return env.WSL_DISTRO_NAME || (procVersion && /microsoft|wsl/i.test(procVersion)) ? 'wsl' : 'linux';
}
