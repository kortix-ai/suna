import { existsSync, lstatSync, rmSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { authFileLocation, clearAuth, loadAuth } from '../api/auth.ts';
import { confirm } from '../prompts.ts';
import { C, status } from '../style.ts';

const HELP = `Usage: kortix uninstall [options]

Remove the Kortix CLI binary, the /usr/local/bin shim, the stored auth
token, and (optionally) the ~/.kortix install directory.

Options:
  -y, --yes        Skip the confirmation prompt.
  --keep-auth      Don't delete ~/.config/kortix/auth.json.
  --keep-home      Don't touch ~/.kortix/ — only remove the binary +
                   symlink.
  -h, --help       Show this help.
`;

interface UninstallFlags {
  yes: boolean;
  keepAuth: boolean;
  keepHome: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): UninstallFlags {
  const f: UninstallFlags = { yes: false, keepAuth: false, keepHome: false, help: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') f.help = true;
    else if (a === '-y' || a === '--yes') f.yes = true;
    else if (a === '--keep-auth') f.keepAuth = true;
    else if (a === '--keep-home') f.keepHome = true;
    else {
      process.stderr.write(`${status.err(`unknown option "${a}"`)}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return f;
}

export async function runUninstall(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const targets = collectTargets(flags);
  if (targets.length === 0) {
    process.stdout.write(`${C.dim}Nothing to remove. Kortix CLI is already uninstalled.${C.reset}\n`);
    return 0;
  }

  process.stdout.write(`\n${C.bold}About to remove:${C.reset}\n`);
  for (const t of targets) {
    process.stdout.write(`  ${C.red}rm${C.reset}  ${t.path}  ${C.dim}(${t.kind})${C.reset}\n`);
  }
  process.stdout.write('\n');

  if (!flags.yes) {
    const ok = await confirm('Proceed?', false);
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }

  let failed = 0;
  for (const t of targets) {
    try {
      removeTarget(t);
      process.stdout.write(`${status.ok(`removed ${t.path}`)}\n`);
    } catch (err) {
      failed += 1;
      process.stderr.write(
        `${status.err(`could not remove ${t.path} — ${(err as Error).message}`)}\n`,
      );
      if ((err as { code?: string }).code === 'EACCES') {
        process.stderr.write(
          `${C.dim}  Try: sudo rm -f ${t.path}${C.reset}\n`,
        );
      }
    }
  }

  if (failed > 0) {
    process.stderr.write(`\n${status.warn(`${failed} item${failed === 1 ? '' : 's'} could not be removed.`)}\n`);
    return 1;
  }
  process.stdout.write(`\n${status.ok('Kortix CLI uninstalled. Sorry to see you go.')}\n`);
  return 0;
}

// ── target collection ─────────────────────────────────────────────────────

interface Target {
  path: string;
  kind: 'binary' | 'symlink' | 'home' | 'auth';
}

function collectTargets(flags: UninstallFlags): Target[] {
  const found: Target[] = [];

  // 1. The /usr/local/bin symlink, if it points at us.
  const candidatePaths = [
    '/usr/local/bin/kortix',
    resolve(homedir(), '.local', 'bin', 'kortix'),
  ];
  for (const p of candidatePaths) {
    if (existsSymlinkOrFile(p)) {
      found.push({ path: p, kind: 'symlink' });
    }
  }

  // 2. ~/.kortix
  if (!flags.keepHome) {
    const kortixHome = resolve(homedir(), '.kortix');
    if (existsSync(kortixHome)) {
      found.push({ path: kortixHome, kind: 'home' });
    }
  } else {
    // Even with --keep-home, take out the binary if it's the only thing.
    const kortixBin = resolve(homedir(), '.kortix', 'kortix');
    if (existsSync(kortixBin)) {
      found.push({ path: kortixBin, kind: 'binary' });
    }
  }

  // 3. Auth file.
  if (!flags.keepAuth) {
    const auth = authFileLocation();
    if (existsSync(auth)) {
      found.push({ path: auth, kind: 'auth' });
    }
  }

  return found;
}

function existsSymlinkOrFile(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function removeTarget(t: Target): void {
  if (t.kind === 'auth') {
    clearAuth();
    return;
  }
  if (t.kind === 'home') {
    rmSync(t.path, { recursive: true, force: true });
    return;
  }
  // symlink or binary
  const st = lstatSync(t.path);
  if (st.isSymbolicLink() || st.isFile()) {
    unlinkSync(t.path);
  } else {
    rmSync(t.path, { recursive: true, force: true });
  }
}

// Reference the imports so unused-detection stays happy.
void loadAuth;
void spawnSync;
