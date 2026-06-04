import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadLocalManifest } from '../manifest.ts';
import { C, status } from '../style.ts';

const HELP = `Usage: kortix dev [opencode args…]

Run OpenCode locally against THIS project's config dir — the same
.kortix/opencode the cloud sandbox uses — so you can test your agents,
skills, tools, and runtime config without spinning up a sandbox. Works
from anywhere inside the project; no cd or OPENCODE_CONFIG_DIR needed.

Examples:
  kortix dev                          # interactive session with your config
  kortix dev run --agent kortix "hi"  # one-shot run of an agent
  kortix dev debug skill              # list the skills your config discovers
  kortix dev debug agent kortix       # resolved agent: model, tools, perms

Scope: this exercises the OpenCode half of your config (agents, skills,
tools, personas, runtime). Connectors/executor, triggers, and channels are
injected by the platform at session start — test those against a live
session (kortix sessions / a deployed project).

Options:
  -h, --help   Show this help.
`;

/** Walk up from cwd to the project root (the dir holding kortix.toml / .kortix). */
function findProjectRoot(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, 'kortix.toml')) || existsSync(resolve(dir, '.kortix'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function runDev(argv: string[]): Promise<number> {
  if (argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return 0;
  }

  const root = findProjectRoot();
  if (!root) {
    process.stderr.write(
      `${status.err('Not inside a Kortix project (no kortix.toml / .kortix found).')}\n` +
        `  ${C.dim}Run ${C.reset}${C.cyan}kortix init${C.reset}${C.dim} first.${C.reset}\n`,
    );
    return 1;
  }

  // Resolve the OpenCode config dir from [opencode].config_dir (default
  // .kortix/opencode), relative to the project root — exactly what the
  // platform points OPENCODE_CONFIG_DIR at in a session.
  let configDir = resolve(root, '.kortix/opencode');
  try {
    const manifest = loadLocalManifest(root);
    const oc = manifest?.data?.opencode as { config_dir?: unknown } | undefined;
    if (oc && typeof oc.config_dir === 'string' && oc.config_dir.trim()) {
      configDir = resolve(root, oc.config_dir.trim());
    }
  } catch {
    // A malformed manifest shouldn't block local testing — fall back to the
    // default config dir. `kortix validate` is the place to surface TOML errors.
  }

  if (!existsSync(configDir)) {
    process.stderr.write(
      `${status.err(`OpenCode config dir not found: ${C.reset}${configDir}`)}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `  ${C.dim}opencode ← ${C.reset}${C.cyan}${configDir}${C.reset}\n`,
  );

  // Hand off to opencode with the config dir wired in; inherit stdio so the
  // interactive TUI / REPL works unchanged.
  const res = spawnSync('opencode', argv, {
    stdio: 'inherit',
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
  });

  if (res.error) {
    const missing = (res.error as NodeJS.ErrnoException).code === 'ENOENT';
    process.stderr.write(
      `${status.err(missing ? 'opencode is not installed or not on PATH.' : `Failed to run opencode: ${res.error.message}`)}\n` +
        (missing ? `  ${C.dim}Install it from ${C.reset}${C.cyan}https://opencode.ai${C.reset}\n` : ''),
    );
    return 1;
  }
  return res.status ?? 0;
}
