export type Platform = 'wsl' | 'darwin' | 'linux' | 'win32';

export type LaunchEnv = {
  platform: Platform;
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  which(cmd: string): string | undefined;
};

export type TerminalRequest = { argv: string[]; cwd?: string; title?: string; keepOpen?: boolean /* default true */ };

export type LaunchPlan = { steps: { command: string; args: string[] }[]; describe: string }; // first step that spawns successfully wins

export type LaunchResult =
  | { status: 'launched'; via: string }
  | { status: 'unsupported'; reason: string; fallback: string }; // fallback = a pasteable command / the URL
