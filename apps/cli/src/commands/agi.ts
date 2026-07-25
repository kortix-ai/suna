/**
 * `kortix agi` — launch Kortix AGI, the control agent that runs ABOVE the
 * user's workspaces rather than inside one.
 *
 * Everything AGI needs arrives through the CLI, never through a repo: this
 * command materializes its OpenCode config dir from the bundled `agi` starter
 * template (`packages/starter/templates/agi`), gives it a scratch cwd that is
 * deliberately NOT a project checkout, and launches OpenCode against it. That
 * constraint is the point — the same command drops into a cloud sandbox later
 * with only the token changing, no clone required.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { getAgiFiles } from '@kortix/starter';
import { loadAuth } from '../api/auth.ts';
import { C, help, status } from '../style.ts';

export const AGI_AGENT_NAME = 'kortix-agi';

const HELP = help`Usage: kortix agi [options] [-- <opencode args…>]

Start Kortix AGI — the control agent that runs above your workspaces.

AGI has no repo. It configures Kortix and gets work done by spawning
sessions (\`kortix sessions new\`) rather than editing code itself. Its
OpenCode config dir is materialized fresh on every run, so it is always the
current pre-configured agent — edit
\`packages/starter/templates/agi/\` to change it, not the materialized copy.

Any flags you pass are forwarded to OpenCode, so its own options work
unchanged (\`--model\`, \`--prompt\`, \`--continue\`, \`--mini\`, …).

Options:
  --home <dir>   Override AGI's home (default: ~/.kortix/agi, or
                 $KORTIX_HOME/agi when set).
  -h, --help     Show this help.

Environment:
  KORTIX_OPENCODE_BIN   OpenCode binary to run (default: opencode).
  KORTIX_HOME           Base dir for Kortix local state (default: ~/.kortix).

Examples:
  kortix agi
  kortix agi --model anthropic/claude-opus-4-8
  kortix agi --prompt "what projects do I have, and what is each one for?"
  kortix agi -- --mini`;

/** Resolve AGI's home dir — its config dir and scratch workspace live here. */
export function agiHome(overrideDir?: string): string {
  if (overrideDir) return resolve(overrideDir);
  const base = process.env.KORTIX_HOME?.trim();
  return base ? resolve(base, 'agi') : join(homedir(), '.kortix', 'agi');
}

/**
 * Write the bundled `agi` template into `<home>/opencode` and ensure the
 * scratch workspace exists. Idempotent, and re-synced on every run so a
 * platform-side prompt change lands without a reinstall. Files whose content
 * already matches are left alone so mtimes don't churn.
 *
 * Returns the two directories OpenCode is launched with.
 */
export function materializeAgiHome(home: string): { configDir: string; workspace: string } {
  const configDir = join(home, 'opencode');
  const workspace = join(home, 'workspace');

  for (const file of getAgiFiles()) {
    const target = join(configDir, ...file.path.split('/'));
    let current: string | null = null;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      current = null;
    }
    if (current === file.content) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }

  // AGI's cwd. Deliberately empty: it is not a checkout, and OpenCode needs
  // *some* directory to anchor its session store to.
  mkdirSync(workspace, { recursive: true });
  return { configDir, workspace };
}

/**
 * Build the OpenCode argv. Everything the caller passed is forwarded verbatim
 * (with a leading `--` separator dropped, so `kortix agi -- --mini` works), and
 * we prepend the two flags that make this AGI rather than a stock OpenCode:
 * the agent selection and full auto-approval. A caller-supplied `--agent` wins,
 * so pointing this launcher at another agent stays possible.
 */
export function buildAgiArgs(argv: string[]): string[] {
  const separator = argv.indexOf('--');
  const forwarded =
    separator >= 0 ? [...argv.slice(0, separator), ...argv.slice(separator + 1)] : [...argv];

  const args: string[] = [];
  if (!forwarded.includes('--agent')) args.push('--agent', AGI_AGENT_NAME);
  // AGI orchestrates: it is expected to make many CLI calls per turn, so
  // prompting for each one would defeat the purpose.
  if (!forwarded.includes('--auto')) args.push('--auto');
  args.push(...forwarded);
  return args;
}

export async function runAgi(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  let homeOverride: string | undefined;
  const homeIndex = rest.indexOf('--home');
  if (homeIndex >= 0) {
    const value = rest[homeIndex + 1];
    if (!value || value.startsWith('-')) {
      process.stderr.write(`${status.err('--home needs a directory.')}\n`);
      return 2;
    }
    rest.splice(homeIndex, 2);
    homeOverride = value;
  }

  const auth = loadAuth();
  if (!auth) {
    process.stderr.write(
      `${status.err('Not logged in.')}\n` +
        `  ${C.dim}AGI drives Kortix through the CLI, so it needs your login. Run \`kortix login\`.${C.reset}\n`,
    );
    return 1;
  }

  const home = agiHome(homeOverride);
  let dirs: { configDir: string; workspace: string };
  try {
    dirs = materializeAgiHome(home);
  } catch (err) {
    process.stderr.write(
      `${status.err(`Could not set up AGI's home at ${home}: ${(err as Error).message}`)}\n`,
    );
    return 1;
  }

  process.stderr.write(
    `${status.ok(`Starting ${C.bold}Kortix AGI${C.reset}`)} ` +
      `${C.dim}(${auth.user_email} · ${auth.api_base})${C.reset}\n`,
  );

  return spawnOpenCode(buildAgiArgs(rest), dirs);
}

function spawnOpenCode(
  args: string[],
  dirs: { configDir: string; workspace: string },
): Promise<number> {
  const bin = process.env.KORTIX_OPENCODE_BIN || 'opencode';
  const child = spawn(bin, args, {
    stdio: 'inherit',
    cwd: dirs.workspace,
    env: { ...process.env, OPENCODE_CONFIG_DIR: dirs.configDir },
  });
  return new Promise((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(
        `${status.err(`Could not run ${bin}: ${err.message}`)}\n` +
          `  ${C.dim}Install OpenCode (https://opencode.ai) or set KORTIX_OPENCODE_BIN.${C.reset}\n`,
      );
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (typeof code === 'number') resolve(code);
      else resolve(signal ? 130 : 1);
    });
  });
}
