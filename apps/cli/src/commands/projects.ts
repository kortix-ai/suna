import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isProjectGlyphColor, isProjectGlyphName, PROJECT_GLYPH_COLORS } from '@kortix/shared';
import { loadAuth, loadAuthForHost } from '../api/auth.ts';
import {
  activeAccount,
  activeHostName,
  clearDefaultProject,
  defaultProject,
  setActiveAccount,
  setDefaultProject,
} from '../api/config.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import { confirm } from '../prompts.ts';
import {
  clearLink,
  isKortixProject,
  loadLink,
  resolveProjectId,
  saveLink,
} from '../project-link.ts';
import { selectFromList } from '../tui-select.ts';
import {
  emitJson,
  locateProjectAnywhere,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import { projectWebUrl } from '../web-url.ts';
import { openInBrowser } from '../browser.ts';
import { appendGitExcludeEntries } from '../git-exclude.ts';
import { configureProjectGitAuth, resolveProjectGitTarget } from '../project-git.ts';
import type { Auth } from '../api/auth.ts';
import type { AccountMembership, MeResponse, ProjectSummary } from '../api/types.ts';
import { authHeaderArgs } from './ship.ts';

/** Back-compat alias — the helper moved to ../project-git.ts so `ship` can use
 *  it without an import cycle through this command module. */
export {
  configureProjectGitAuth as configureClonedProjectAuth,
  currentGitCredentialHelperCommand,
} from '../project-git.ts';

const HELP = help`Usage: kortix projects <subcommand>

Subcommands:
  ls [--all]           List projects in the active account (--all spans every
                       account, grouped). --query <text> filters by name, id
                       or repo. (--json)
  info [<id>]          Show one project (defaults to the linked/default) (--json)
  set [<id>]           Update name, branch, manifest path or icon.
  rename [<id>] <name> Alias for \`projects set --name <name>\`.
  cli-tokens ls|new|rm Project-scoped CLI tokens (kortix_pat_…).
  upgrade [<id>]       Start the agent session that migrates a v1 kortix.toml
                       to a v2 kortix.yaml and opens a change request.
  use [<id>]           Set the global DEFAULT project (interactive if omitted).
                       Switches the active account to the project's account.
  unset                Clear the global default project.
  link [<id>]          Bind cwd to a remote project (writes .kortix/link.json)
  unlink               Remove .kortix/link.json from cwd
  open [<id>]          Open the dashboard URL for one project
  clone [<id>] [dir]   Clone through the authenticated Kortix git proxy. Falls
                       back to your local Git credentials for direct BYO repos.
  rm [<id>]            Archive a project (defaults to the linked one).
                       --purge also deletes its managed git repo (irreversible).
                       -y / --yes skips the confirmation.
  features [ls]        List every feature flag with its effective state for the
                       project (Settings → Feature flags). (--json)
  features enable <flag>   Turn a flag on for the project.
  features disable <flag>  Turn a flag off for the project.
  features reset <flag>    Clear the project's override (follow the default).
                       features takes --project <id>; defaults to linked/default.

An explicit <id> on info/open/rm resolves on its own: tries the active host
first, then — unless you pass --host — scans every other logged-in host for
it. A directory link (.kortix/link.json) always wins over the default; the
default is what commands use anywhere else on your machine.

Run \`kortix projects <subcommand> --help\` for options.
`;

export async function runProjects(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // Most subcommands own no dedicated help text and do not parse -h/--help
  // themselves, so without this a bare `--help` falls through as an ordinary
  // positional arg — e.g. `projects info --help` would try to look up a
  // project literally named "--help", and `projects rm --help` would silently
  // fall back to archiving the DEFAULT project instead of showing usage. The
  // subcommands listed here DO own their help text and parse the flag
  // themselves, so the fallback must not swallow it.
  const OWNS_HELP = new Set([
    'features',
    'flags',
    'set',
    'update',
    'rename',
    'cli-tokens',
    'cli-token',
    'upgrade',
  ]);
  if ((rest.includes('-h') || rest.includes('--help')) && !OWNS_HELP.has(sub)) {
    process.stdout.write(HELP);
    return 0;
  }
  switch (sub) {
    case 'ls':
    case 'list': {
      const restCopy = [...rest];
      const all = takeFlagBool(restCopy, ['--all', '-a']);
      const json = takeFlagBool(restCopy, ['--json']);
      let query: string | undefined;
      let hostArg: string | undefined;
      let accountArg: string | undefined;
      try {
        query = takeFlagValue(restCopy, ['--query', '-q']);
        hostArg = takeFlagValue(restCopy, ['--host']);
        accountArg = takeFlagValue(restCopy, ['--account']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsLs(json, all, query, hostArg, accountArg);
    }
    case 'set':
    case 'update':
      return projectsSet(rest);
    case 'rename':
      return projectsRename(rest);
    case 'cli-tokens':
    case 'cli-token':
      return projectsCliTokens(rest);
    case 'upgrade':
      return projectsUpgrade(rest);
    case 'info': {
      const restCopy = [...rest];
      const json = takeFlagBool(restCopy, ['--json']);
      let hostArg: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsInfo(restCopy[0], json, hostArg);
    }
    case 'use':
    case 'default':
      return projectsUse(rest.find((a) => !a.startsWith('-')));
    case 'unset':
    case 'clear':
      return projectsUnset();
    case 'link':
      return projectsLink(rest[0]);
    case 'unlink':
      return projectsUnlink();
    case 'open': {
      const restCopy = [...rest];
      let hostArg: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsOpen(restCopy[0], hostArg);
    }
    case 'clone': {
      const restCopy = [...rest];
      let hostArg: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsClone(restCopy[0], restCopy[1], hostArg);
    }
    case 'rm':
    case 'remove':
      return projectsRm(rest);
    case 'features':
    case 'flags':
      return projectsFeatures(rest);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

// ── Feature flags (Settings → Feature flags) ───────────────────────────────

const FEATURES_HELP = help`Usage: kortix projects features [ls | enable | disable | reset] [<flag>]

Per-project feature flags — the same switches as Settings → Feature flags.
A flag is a stable key (e.g. apps, voice, llm_gateway). State is stored on
the project row, never in kortix.yaml.

Subcommands:
  ls                    List every flag: key, state, origin. (--json)
  enable <flag>         Set the project override to ON.
  disable <flag>        Set the project override to OFF.
  reset <flag>          Remove the override; the flag follows the platform default.

Options:
  --project <id>        Act on this project (default: linked/default project).
  --host <name>         Use this logged-in host.
  --json                Machine-readable output.

Requires project.customize.write. A flag the platform marks unavailable stays
off regardless of the project override.
`;

interface FeatureFlagRow {
  key: string;
  name: string;
  description: string;
  stability: string;
  available: boolean;
  enabled: boolean;
  overridden: boolean;
}

function featureRows(project: Record<string, unknown>): FeatureFlagRow[] {
  const raw = project.experimental_features;
  return Array.isArray(raw) ? (raw as FeatureFlagRow[]) : [];
}

function printFeatureTable(rows: FeatureFlagRow[]): void {
  if (rows.length === 0) {
    process.stdout.write(`${status.info('No feature flags reported by this host.')}\n`);
    return;
  }
  const keyW = Math.max(4, ...rows.map((r) => r.key.length));
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('FLAG', keyW)}  ${pad('STATE', 5)}  ${pad('ORIGIN', 10)}  ${pad('STABILITY', 13)}NAME${C.reset}\n`,
  );
  for (const r of rows) {
    const state = !r.available
      ? `${C.faded}n/a  ${C.reset}`
      : r.enabled
        ? `${C.green}on   ${C.reset}`
        : `${C.dim}off  ${C.reset}`;
    const origin = !r.available ? 'unavailable' : r.overridden ? 'override' : 'default';
    process.stdout.write(
      `  ${pad(r.key, keyW)}  ${state}  ${pad(origin, 10)}  ${r.name}\n`,
    );
  }
  process.stdout.write('\n');
}

async function projectsFeatures(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(FEATURES_HELP);
    return 0;
  }
  const json = takeFlagBool(rest, ['--json']);
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  try {
    projectArg = takeFlagValue(rest, ['--project', '-p']);
    hostArg = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const sub = rest[0] ?? 'ls';
  const flag = rest[1];

  const ctx = await resolveProjectContext({ projectArg, hostArg });
  if (!ctx) return 1;
  const { client, projectId } = ctx;

  if (sub === 'ls' || sub === 'list') {
    try {
      const project = await client.get<Record<string, unknown>>(`/projects/${projectId}`);
      const rows = featureRows(project);
      if (json) {
        emitJson(rows);
        return 0;
      }
      printFeatureTable(rows);
      return 0;
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  if (sub === 'enable' || sub === 'on' || sub === 'disable' || sub === 'off' || sub === 'reset' || sub === 'clear') {
    if (!flag) {
      process.stderr.write(`${status.err(`features ${sub} requires a <flag>.`)}\n\n${FEATURES_HELP}`);
      return 2;
    }
    const enabled = sub === 'enable' || sub === 'on' ? true : sub === 'disable' || sub === 'off' ? false : null;
    try {
      const project = await client.patch<Record<string, unknown>>(`/projects/${projectId}/features`, {
        feature: flag,
        enabled,
      });
      const row = featureRows(project).find((r) => r.key === flag);
      if (json) {
        emitJson(row ?? { key: flag, enabled });
        return 0;
      }
      const verb = enabled === null ? 'reset to default' : enabled ? 'enabled' : 'disabled';
      const effective = row ? (row.available ? (row.enabled ? 'on' : 'off') : 'unavailable on this host') : '?';
      process.stdout.write(`${status.ok(`${flag} ${verb} — effective: ${effective}`)}\n`);
      if (row && !row.available) {
        process.stdout.write(
          `${status.warn(`${flag} is not available on this host; the override is stored but has no effect.`)}\n`,
        );
      }
      return 0;
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  process.stderr.write(`${status.err(`unknown features subcommand "${sub}"`)}\n\n${FEATURES_HELP}`);
  return 2;
}

/** `--glyph <name>:<color>` → the `icon_glyph` object the API validates.
 *  Returns null on an unknown name or color so the CLI can refuse loudly —
 *  the server would silently degrade an invalid glyph to "no glyph". */
function parseGlyphFlag(raw: string): { name: string; color: string } | null {
  const at = raw.lastIndexOf(':');
  if (at <= 0 || at === raw.length - 1) return null;
  const name = raw.slice(0, at);
  const color = raw.slice(at + 1);
  if (!isProjectGlyphName(name) || !isProjectGlyphColor(color)) return null;
  return { name, color };
}

/** `serializeProject`'s icon fields, which `ProjectSummary` does not carry. */
interface ProjectWithIcon extends ProjectSummary {
  icon?: string | null;
  icon_glyph?: { name: string; color: string } | null;
}

// ── Settings → General (name / branch / manifest / icon) ───────────────────

const SET_HELP = help`Usage: kortix projects set [<id>] [options]

Update one project's settings — the dashboard's Customize → Settings →
General (PATCH /projects/:id). Only the fields you pass are written.

Options:
  --name <name>          Display name.
  --branch <branch>      Default branch.
  --manifest <path>      Manifest path, e.g. kortix.yaml.
  --icon <emoji>         Set the per-project emoji.
  --no-icon              Remove the emoji.
  --glyph <name>:<color> Set the per-project glyph, e.g. Rocket:blue.
                         Colors: ${PROJECT_GLYPH_COLORS.join(', ')}.
  --no-glyph             Remove the glyph.
  --project <id>         Act on this project (default: linked/default).
  --host <name>          Use this logged-in host.
  --json                 Emit the updated project as JSON.
  -h, --help             Show this help.

Requires project.customize.write. The icon fields are three-state: omit to
leave as-is, --no-icon / --no-glyph to remove. A project shows ONE icon, so
writing either clears the other; --icon with --glyph is refused. Passing no
field at all exits 2 rather than issuing a no-op write.
`;

interface ProjectPatchRequest {
  projectArg?: string;
  hostArg?: string;
  json: boolean;
  body: Record<string, unknown>;
}

async function applyProjectPatch(req: ProjectPatchRequest): Promise<number> {
  const ctx = await resolveProjectContext({ projectArg: req.projectArg, hostArg: req.hostArg });
  if (!ctx) return 1;
  let project: ProjectWithIcon;
  try {
    project = await ctx.client.patch<ProjectWithIcon>(`/projects/${ctx.projectId}`, req.body);
  } catch (err) {
    return surfaceApiError(err);
  }
  if (req.json) {
    emitJson(project);
    return 0;
  }
  process.stdout.write(`${status.ok(`Updated ${C.bold}${project.name}${C.reset}`)}\n`);
  if ('name' in req.body) process.stdout.write(`  ${C.dim}name     ${C.reset}${project.name}\n`);
  if ('default_branch' in req.body) {
    process.stdout.write(`  ${C.dim}branch   ${C.reset}${project.default_branch}\n`);
  }
  if ('manifest_path' in req.body) {
    process.stdout.write(`  ${C.dim}manifest ${C.reset}${project.manifest_path}\n`);
  }
  if ('icon' in req.body || 'icon_glyph' in req.body) {
    const glyph = project.icon_glyph;
    const shown = glyph ? `${glyph.name}:${glyph.color}` : (project.icon ?? '(none)');
    process.stdout.write(`  ${C.dim}icon     ${C.reset}${shown}\n`);
  }
  return 0;
}

async function projectsSet(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(SET_HELP);
    return 0;
  }
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let name: string | undefined;
  let branch: string | undefined;
  let manifest: string | undefined;
  let iconArg: string | undefined;
  let glyphArg: string | undefined;
  let noIcon = false;
  let noGlyph = false;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project', '-p']);
    hostArg = takeFlagValue(rest, ['--host']);
    name = takeFlagValue(rest, ['--name']);
    branch = takeFlagValue(rest, ['--branch']);
    manifest = takeFlagValue(rest, ['--manifest']);
    iconArg = takeFlagValue(rest, ['--icon']);
    glyphArg = takeFlagValue(rest, ['--glyph']);
    noIcon = takeFlagBool(rest, ['--no-icon']);
    noGlyph = takeFlagBool(rest, ['--no-glyph']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  if (iconArg && glyphArg) {
    process.stderr.write(
      `${status.err('Pass --icon or --glyph, not both — a project shows one icon.')}\n`,
    );
    return 2;
  }

  const body: Record<string, unknown> = {};
  if (name) body.name = name;
  if (branch) body.default_branch = branch;
  if (manifest) body.manifest_path = manifest;
  if (glyphArg) {
    const glyph = parseGlyphFlag(glyphArg);
    if (!glyph) {
      process.stderr.write(
        `${status.err(`Invalid --glyph "${glyphArg}". Use <name>:<color>, e.g. Rocket:blue.`)}\n` +
          `  ${C.dim}colors: ${PROJECT_GLYPH_COLORS.join(', ')}${C.reset}\n`,
      );
      return 2;
    }
    body.icon_glyph = glyph;
  } else if (noGlyph) {
    body.icon_glyph = null;
  }
  if (iconArg) body.icon = iconArg;
  else if (noIcon) body.icon = null;

  if (Object.keys(body).length === 0) {
    process.stderr.write(`${status.err('set requires at least one field.')}\n\n${SET_HELP}`);
    return 2;
  }
  const id = rest.find((a) => !a.startsWith('-')) ?? projectArg;
  return applyProjectPatch({ projectArg: id, hostArg, json, body });
}

async function projectsRename(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(SET_HELP);
    return 0;
  }
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project', '-p']);
    hostArg = takeFlagValue(rest, ['--host']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length === 0 || positional.length > 2) {
    process.stderr.write(`${status.err('rename takes [<id>] <new-name>.')}\n\n${SET_HELP}`);
    return 2;
  }
  const newName = positional[positional.length - 1];
  const id = positional.length === 2 ? positional[0] : projectArg;
  return applyProjectPatch({ projectArg: id, hostArg, json, body: { name: newName } });
}

// ── Project-scoped CLI tokens ──────────────────────────────────────────────

const CLI_TOKENS_HELP = help`Usage: kortix projects cli-tokens [ls | new | rm <token-id>] [options]

Project-scoped CLI tokens (kortix_pat_…). A token is bound to ONE project —
the API rejects it on every other project. Session sandboxes use their
session-bound KORTIX_TOKEN instead.

Subcommands:
  ls                   List this project's tokens. (--json)
  new                  Mint one. The secret is printed ONCE and never again.
  rm <token-id>        Revoke one.

Options:
  --name <name>        new: label (default: "cli · <project name>").
  --project <id>       Act on this project (default: linked/default).
  --host <name>        Use this logged-in host.
  --json               Machine-readable output.
  -y, --yes            rm: skip the confirmation.
  -h, --help           Show this help.

ls needs project read; new and rm need project.credentials.issue. An
agent-session token can neither mint nor revoke project tokens (403).
`;

interface CliTokenRow {
  token_id: string;
  name: string;
  public_key: string;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface CreatedCliToken extends CliTokenRow {
  secret_key: string;
  project_id: string;
}

async function projectsCliTokens(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(CLI_TOKENS_HELP);
    return 0;
  }
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let tokenName: string | undefined;
  let json = false;
  let yes = false;
  try {
    projectArg = takeFlagValue(rest, ['--project', '-p']);
    hostArg = takeFlagValue(rest, ['--host']);
    tokenName = takeFlagValue(rest, ['--name']);
    json = takeFlagBool(rest, ['--json']);
    yes = takeFlagBool(rest, ['-y', '--yes']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  const sub = positional[0] ?? 'ls';

  const ctx = await resolveProjectContext({ projectArg, hostArg });
  if (!ctx) return 1;
  const path = `/projects/${ctx.projectId}/cli-token`;

  if (sub === 'ls' || sub === 'list') {
    try {
      const { items } = await ctx.client.get<{ items: CliTokenRow[] }>(path);
      if (json) {
        emitJson(items);
        return 0;
      }
      if (items.length === 0) {
        process.stdout.write(`${status.info('No CLI tokens on this project.')}\n`);
        return 0;
      }
      const idW = Math.max(8, ...items.map((t) => t.token_id.length));
      const nameW = Math.max(4, ...items.map((t) => t.name.length));
      process.stdout.write('\n');
      process.stdout.write(
        `  ${C.dim}${pad('TOKEN ID', idW)}  ${pad('NAME', nameW)}  ${pad('STATUS', 8)}  LAST USED${C.reset}\n`,
      );
      for (const t of items) {
        const used = t.last_used_at ? formatRelative(t.last_used_at) : 'never';
        process.stdout.write(
          `  ${pad(t.token_id, idW)}  ${pad(t.name, nameW)}  ${pad(t.status, 8)}  ${C.faded}${used}${C.reset}\n`,
        );
      }
      process.stdout.write(`\n  ${C.dim}${items.length} token${items.length === 1 ? '' : 's'}${C.reset}\n\n`);
      return 0;
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  if (sub === 'new' || sub === 'create') {
    let created: CreatedCliToken;
    try {
      created = await ctx.client.post<CreatedCliToken>(path, tokenName ? { name: tokenName } : {});
    } catch (err) {
      return surfaceApiError(err);
    }
    if (json) {
      emitJson(created);
      return 0;
    }
    process.stdout.write(`${status.ok(`Minted ${C.bold}${created.name}${C.reset}`)}\n`);
    process.stdout.write(`  ${C.dim}token_id ${C.reset}${created.token_id}\n`);
    process.stdout.write(`  ${C.dim}project  ${C.reset}${created.project_id}\n`);
    process.stdout.write(`\n  ${created.secret_key}\n\n`);
    process.stdout.write(
      `${status.warn('Copy the secret now — it is shown once and never stored in readable form.')}\n`,
    );
    return 0;
  }

  if (sub === 'rm' || sub === 'remove' || sub === 'revoke') {
    const tokenId = positional[1];
    if (!tokenId) {
      process.stderr.write(
        `${status.err('cli-tokens rm requires a <token-id>.')}\n\n${CLI_TOKENS_HELP}`,
      );
      return 2;
    }
    if (!yes) {
      const ok = await confirm(
        `Revoke CLI token ${C.bold}${tokenId}${C.reset}? Anything still using it stops working.`,
        false,
      );
      if (!ok) {
        process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
        return 0;
      }
    }
    try {
      await ctx.client.delete(`${path}/${encodeURIComponent(tokenId)}`);
    } catch (err) {
      return surfaceApiError(err);
    }
    if (json) {
      emitJson({ ok: true, token_id: tokenId });
      return 0;
    }
    process.stdout.write(`${status.ok(`Revoked ${tokenId}`)}\n`);
    return 0;
  }

  process.stderr.write(
    `${status.err(`unknown cli-tokens subcommand "${sub}"`)}\n\n${CLI_TOKENS_HELP}`,
  );
  return 2;
}

// ── Customize → Upgrades (manifest v1 → v2) ────────────────────────────────

const UPGRADE_HELP = help`Usage: kortix projects upgrade [<id>] [options]

Start the agent session that migrates a v1 \`kortix.toml\` to a v2
\`kortix.yaml\` — the dashboard's Customize → Upgrades → "Migrate manifest to
v2". The project's default agent rewrites the manifest, runs
\`kortix validate\`, and opens a change request. It never
merges: a human reviews the diff.

Options:
  --project <id>       Act on this project (default: linked/default).
  --host <name>        Use this logged-in host.
  --json               Machine-readable output.
  -h, --help           Show this help.

Requires project write (session create). Run \`kortix files cat kortix.yaml\`
first — a project already on kortix_version 2 has nothing to migrate.
`;

async function projectsUpgrade(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(UPGRADE_HELP);
    return 0;
  }
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project', '-p']);
    hostArg = takeFlagValue(rest, ['--host']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const id = rest.find((a) => !a.startsWith('-')) ?? projectArg;
  const ctx = await resolveProjectContext({ projectArg: id, hostArg });
  if (!ctx) return 1;

  let session: { session_id: string };
  try {
    // The web stashes the prompt client-side (`pending_prompt`) because a
    // browser is there to deliver it. The CLI has no such client, so the
    // prompt goes as `initial_prompt` — the server delivers it and the
    // session starts working on its own.
    session = await ctx.client.post<{ session_id: string }>(`/projects/${ctx.projectId}/sessions`, {
      initial_prompt: MIGRATE_TO_V2_PROMPT,
      name: 'Migrate manifest to v2',
      metadata: { kind: 'project-upgrade', upgrade_id: 'manifest-v2' },
    });
  } catch (err) {
    return surfaceApiError(err);
  }
  const output = {
    session_id: session.session_id,
    project_id: ctx.projectId,
    upgrade_id: 'manifest-v2',
  };
  if (json) {
    emitJson(output);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Started upgrade session ${C.bold}${session.session_id}${C.reset}`)}\n`,
  );
  process.stdout.write(`  ${C.dim}upgrade   ${C.reset}manifest-v2 (kortix.toml → kortix.yaml)\n`);
  process.stdout.write(
    `\n  ${C.dim}Watch it:${C.reset} ${C.cyan}kortix connect ${session.session_id}${C.reset}\n`,
  );
  return 0;
}

/**
 * The seed prompt for the v1 → v2 manifest migration.
 *
 * VERBATIM COPY of `MIGRATE_TO_V2_PROMPT` in
 * `apps/web/src/features/workspace/customize/migrate-to-v2/migration-prompt.ts`,
 * which is the source of truth. The CLI cannot import from `apps/web` and the
 * prompt lives in no shared package, so both doors must be edited together —
 * `kortix projects upgrade` and the dashboard's Upgrades button must seed the
 * SAME contract, or two users running "the same" upgrade get different diffs.
 */
const MIGRATE_TO_V2_PROMPT = `Migrate this project's manifest from kortix_version 1 (kortix.toml) to kortix_version 2 (kortix.yaml). Read everything first, then make the change, then land it as a change request — do not merge it yourself.

## 1. Read before you write

- The current manifest: \`kortix.toml\` (or \`kortix.yaml\` if this project already partially moved — check \`kortix_version\` at the top either way).
- Any \`[[agents]]\` entries in the v1 manifest — these carry \`connectors\`, \`kortix_cli\`, and \`env\` grants per agent name. An agent name with NO \`[[agents]]\` entry at all is today unrestricted (v1's back-compat default is "all" when a grant key is omitted).
- \`.kortix/opencode/opencode.jsonc\` — if it sets a top-level \`default_agent\`, that is the project's existing default; use it. If it doesn't, pick the agent whose \`.kortix/opencode/agents/*.md\` frontmatter has \`mode: primary\` and reads as the general/primary one (usually the first-created or the one with the broadest permissions). Record which you picked and why in the change request description — a human reviews this before it merges, so a defensible choice beats blocking on it.
- **You do NOT need to read each agent's \`.md\` frontmatter to migrate it.** v1's frontmatter (mode/model/temperature/permission/prompt/…) is ALREADY valid v2 OpenCode behavior — it stays exactly where it is, unchanged. This migration is governance-only.

## 2. The authoritative schema is one command away

Whenever you are unsure about a field name, an allowed value, or whether a key survived into v2, consult the canonical JSON Schema instead of guessing:

- \`kortix schema --version 2\` — prints the exact v2 schema the validator and the CR-merge gate enforce. Works offline inside your sandbox. \`kortix schema --version 1\` prints the v1 shape you are migrating FROM.
- The same documents are published at \`https://kortix.com/schema/kortix.v2.schema.json\` (and \`kortix.v1.schema.json\`, plus the combined \`kortix.schema.json\` that dispatches on \`kortix_version\`).

The schema, this prompt, and \`kortix validate\` all enforce the same rules — if they ever appear to disagree, trust \`kortix validate\`'s output and say so in the change request description.

## 3. The v2 shape you're producing

v2's \`agents:\` map is GOVERNANCE ONLY — connectors/secrets/skills/kortix_cli/workspace/enabled. OpenCode behavior (mode/model/temperature/permission/the prompt itself) is NOT part of the manifest at all; it lives entirely in each agent's own native \`.kortix/opencode/agents/<name>.md\` frontmatter + body, exactly as it does today. The agent's NAME is the join between this map's keys and that \`.md\`'s filename.

\`\`\`yaml
kortix_version: 2
default_agent: <name>          # REQUIRED — must resolve to a declared, enabled agent below

agents:
  <name>:
    enabled: true                # optional; false = can't start sessions (default true)
    connectors: all               # connector slugs | "all" | "none"
    secrets: all                  # renamed from v1's "env" — names | "all" | "none"
    kortix_cli: all                # kortix_cli leaf names | "all" | "none"
    skills: all                    # names of .kortix/opencode/skills/* this agent may invoke | "all" | "none"
    workspace: runtime             # optional — runtime | read | branch
\`\`\`

That's the WHOLE block. No \`description\`, no \`model\`, no \`opencode:\` sub-object, no \`mode\`/\`temperature\`/\`permission\`/\`prompt\` — every one of those is a hard schema error if authored here. They already live in the \`.md\` and are staying there.

Rules that the schema enforces (get these right or \`kortix validate\` fails):

- \`agents\` is a MAP (\`name: {...}\`), not the v1 \`[[agents]]\` array of tables.
- \`default_agent\` is required at the top level and must name a declared, enabled (\`enabled\` not \`false\`) agent.
- Any behavioral field (\`description\`, \`model\`, \`mode\`, \`temperature\`, \`top_p\`, \`steps\`, \`variant\`, \`color\`, \`hidden\`, \`permission\`, \`prompt\`, or a nested \`opencode:\` block) authored on the manifest agent block is a hard error, pointing you at the agent's own \`.md\` frontmatter instead — because that's where it already lives, untouched.
- \`disable\` is a hard error too — it's the manifest-governance \`enabled\` (inverted): write \`enabled: false\` instead. (This is unrelated to a NATIVE \`disable\` key that might already be hand-authored in an agent's own \`.md\` frontmatter — leave that alone; it's a different, runtime-level concept.)
- \`env\` is a hard error in v2 — it is renamed \`secrets\`. **v2 defaults every omitted grant (\`connectors\`/\`secrets\`/\`kortix_cli\`/\`skills\`) to \`"none"\` (deny-by-default), unlike v1 which defaulted an omitted grant to \`"all"\`.** To avoid silently narrowing an agent's access during migration, write the EXPLICIT value that reproduces today's behavior for every agent — if a v1 agent had no \`[[agents]]\` entry, or its \`env\`/\`connectors\`/\`kortix_cli\` were omitted or set to \`all\`, write \`secrets: all\`, \`connectors: all\`, \`kortix_cli: all\` explicitly in its v2 block. Only narrow a grant if the v1 manifest already narrowed it (an explicit list, or \`none\`) — carry that exact list over. \`skills\` has no v1 equivalent; default new agents to \`all\` unless you have a specific reason to narrow.
- \`channels\` is removed entirely in v2 — delete any \`[[channels]]\` block. Channel↔agent routing now lives in the dashboard (Customize → Channels), not in git. Do not try to replicate it in the manifest.
- Every other top-level section (\`project\`, \`env\` for required/optional documentation vars — NOT the per-agent grant, top-level \`opencode\` config-dir settings, \`sandbox\`, \`triggers\`, \`connectors\`, \`apps\`) keeps its v1 shape unchanged — translated to YAML, not restructured. If \`triggers[].agent\` names an agent, make sure that name still exists in the new \`agents\` map (rename references if you renamed an agent).
- If an agent has no \`.md\` today (a bare \`[[agents]]\` entry with no matching OpenCode agent file), still declare it in \`agents:\` with its governance grants carried over — don't drop it. It will simply have no behavior until someone adds \`.kortix/opencode/agents/<name>.md\`.

## 4. Legacy keys v2 refuses — drop these while you convert

v1 tolerates several retired keys with a deprecation warning; v2 makes every one of them a hard error. Remove them as part of the conversion and note each removal in the change request description:

- **Retired \`kortix_cli\` actions** — \`project.session.exec\`, \`project.gateway.routing.edit\`, \`project.schedule.read\`, \`project.schedule.write\`, \`project.webhook.read\`, \`project.webhook.write\`, \`channel.read\`, \`channel.connect\`, \`channel.send\`, \`channel.disconnect\`. These were removed from the enforcement catalog and have been no-ops for a while — granting or omitting them never had any effect, so deleting them from a grant list changes nothing. Do NOT substitute a broader grant (e.g. \`all\`) to "cover" a deleted action.
- **\`credential = "per_user"\` on a \`[[connectors]]\` entry** — the per-user credential mode was removed; every connector is \`"shared"\` now. Delete the \`credential\` key (or write \`shared\` explicitly if the entry already spelled it out).
- **\`agent_scope\` on a \`[[connectors]]\` entry** — retired; the runtime no longer reads it. Per-agent connector access is expressed from the OTHER side now: each agent's \`connectors:\` grant in the \`agents:\` map. If a v1 connector had \`agent_scope = ["a", "b"]\`, make sure agents outside that list don't get that connector slug in their \`connectors\` grant (use an explicit slug list instead of \`all\` for the agents that should keep access), then delete the key.
- **Legacy singular \`[sandbox]\` image keys** (\`image\`, \`dockerfile\`, \`cpu\`, \`memory\`, \`disk\`, …) — already an error in v1's validator; if \`kortix validate\` flags them, move the image definition under \`[[sandbox.templates]]\` → \`sandbox.templates:\` with a named slug.

## 5. Worked example

A representative v1 \`kortix.toml\`:

\`\`\`toml
kortix_version = 1

[project]
name = "acme-ops"

[env]
required = ["DATABASE_URL"]

[[agents]]
name = "dev"
connectors = ["github", "linear"]
env = "all"
kortix_cli = ["project.file.read", "project.file.write", "project.session.exec"]

[[agents]]
name = "support"
# no grants declared — v1 treats omitted grants as "all"

[[channels]]
type = "slack"
agent = "support"

[[triggers]]
slug = "weekly-summary"
type = "cron"
cron = "0 9 * * 1"
agent = "dev"
prompt = "Post the weekly summary."

[[connectors]]
slug = "github"
provider = "github"
credential = "per_user"
agent_scope = ["dev"]
\`\`\`

becomes this v2 \`kortix.yaml\`:

\`\`\`yaml
kortix_version: 2
default_agent: dev

project:
  name: acme-ops

env:
  required:
    - DATABASE_URL

agents:
  dev:
    connectors:
      - github
      - linear
    secrets: all          # v1 "env = all", renamed
    kortix_cli:           # project.session.exec dropped — retired no-op action
      - project.file.read
      - project.file.write
    skills: all
  support:
    # v1 had no grants (implicit all) — but the github connector was
    # agent_scoped to dev only, so "all" would WIDEN support's access.
    # An explicit list preserves today's effective behavior instead.
    connectors: none
    secrets: all
    kortix_cli: all
    skills: all

triggers:
  - slug: weekly-summary
    type: cron
    cron: "0 9 * * 1"
    agent: dev
    prompt: Post the weekly summary.

connectors:
  - slug: github
    provider: github
    # credential/agent_scope removed — connectors are shared; per-agent
    # access now lives in the agents map above.
\`\`\`

Note what happened: the \`[[channels]]\` block is gone (dashboard-owned now), \`env\` became \`secrets\`, the retired CLI action and connector keys were dropped, every omitted-in-v1 grant was written out explicitly, and the old \`agent_scope\` was honored by adjusting the AGENTS' \`connectors\` grants rather than copied over. Your project will differ — apply the rules, not this output verbatim.

## 6. Leave every agent's \`.md\` alone

Do not open, edit, or reformat any \`.kortix/opencode/agents/*.md\` file as part of this migration. Its frontmatter (mode/model/permission/temperature/…) and body (the system prompt) are ALREADY the agent's v2 behavior — nothing about them needs to change. This is what makes this migration governance-only and comparatively small: you're translating one array-of-tables into one map of governance grants, full stop.

## 7. Write the file, remove the old one

- Write the fully assembled manifest to \`kortix.yaml\` at the repo root (same directory as the old \`kortix.toml\`).
- Carry over meaningful TOML comments as YAML comments next to the same keys — hand-written context in a manifest is documentation someone chose to leave; don't strip it.
- Delete the old \`kortix.toml\` in the same commit — don't leave both files (the platform always prefers \`kortix.yaml\` when both exist, but a stale v1 file next to it is confusing for the next person who edits by hand).
- You do not need to touch any project setting outside git — the platform resolves \`kortix.yaml\` automatically once it exists, regardless of the configured manifest filename.

## 8. Validate before you're done

Run \`kortix validate\` (it auto-detects \`kortix.yaml\`). Fix every error it reports — do not open the change request with a manifest that fails validation. Warnings are fine to leave if they're informational, but read them. If an error surprises you, cross-check the field against \`kortix schema --version 2\`.

## 9. Land it as a change request — never merge

First, re-sync: \`git fetch origin\` and check whether \`origin/main\` advanced while you worked (\`git log HEAD..origin/main --oneline\`) — on active projects it will (connectors added from the dashboard, other sessions merging). If it moved, rebase; if the rebase conflicts on \`kortix.toml\` (main changed the manifest you deleted), don't fight it — \`git rebase --abort\`, \`git reset --hard origin/main\`, and redo the conversion against the CURRENT manifest, then continue. Never revert main's changes to win a conflict.

Then commit, **push the branch**, and open the change request. A commit that is never pushed leaves the CR empty ("No changes detected") and un-appliable — the platform refuses such a CR outright (\`422 CR_HEAD_NOT_AHEAD\`):

\`\`\`
git add -A && git commit -m "Migrate manifest to kortix_version 2 (kortix.yaml)"
git push origin HEAD
kortix cr open --head <your-branch> --title "Migrate manifest to kortix_version 2 (kortix.yaml)" --description "<what you converted, which agent you picked as default_agent and why, every legacy key you removed, and any grant you had to leave narrowed>"
\`\`\`

If the push is rejected because the remote session branch moved, \`git fetch origin\` then \`git push --force-with-lease origin HEAD\` — your own session branch only, never any other branch.

Then verify the CR actually carries your diff: run \`kortix cr diff <number>\` — if it reports no changes, your push didn't land; push again and re-check (the CR updates automatically, do not open a second one).

Do **not** run \`kortix cr merge\`. This is a human-reviewed change like any other — stop once the CR is open and verified non-empty, and tell the user its number so they can review the diff and merge it themselves.`;

export interface ProjectCloneTarget {
  repoUrl: string;
  token: string | null;
  username: string;
  needsManagedToken: boolean;
}

export function saveClonedProjectLink(
  repoRoot: string,
  project: ProjectSummary,
  host: string | undefined,
  hostUrl: string,
): void {
  saveLink(
    {
      project_id: project.project_id,
      account_id: project.account_id,
      host,
      host_url: hostUrl,
      linked_at: new Date().toISOString(),
    },
    repoRoot,
  );

  appendGitExcludeEntries(
    repoRoot,
    ['/.kortix/link.json'],
    'Kortix local project binding',
  );
}

/** Resolve clone auth without ever placing a credential in the remote URL.
 *  Thin adapter over the shared resolver in ../project-git.ts — the same
 *  decision `kortix ship` and the git credential helper make. */
export function resolveProjectCloneTarget(
  project: ProjectSummary,
  kortixToken: string,
): ProjectCloneTarget {
  const target = resolveProjectGitTarget(project);
  return {
    repoUrl: target.repoUrl,
    token: target.credentialMode === "kortix-token" ? kortixToken : null,
    username: "x-access-token",
    needsManagedToken: target.credentialMode === "managed-git-token",
  };
}

async function projectsClone(
  arg?: string,
  destination?: string,
  hostArg?: string,
): Promise<number> {
  const id = arg ?? resolveProjectId();
  if (!id) {
    process.stderr.write(
      `${status.err("No project selected. Run `kortix projects use`, link a directory, or pass an id.")}\n`,
    );
    return 1;
  }

  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix projects clone ${id} --host ${host}`,
  );
  if (!located) return 1;

  const { client, auth, project } = located.located;
  const target = resolveProjectCloneTarget(project, auth.token);
  if (target.needsManagedToken) {
    try {
      const credential = await client.post<{
        push_token: string;
        git_username?: string;
      }>(`/projects/${project.project_id}/git-token`);
      target.token = credential.push_token;
      target.username = credential.git_username || target.username;
    } catch (err) {
      return surface(err);
    }
  }

  const args = target.token
    ? [
        ...authHeaderArgs(target.repoUrl, target.token, target.username),
        "clone",
        target.repoUrl,
      ]
    : ["clone", target.repoUrl];
  if (destination) args.push(destination);

  const cloned = spawnSync("git", args, { stdio: "inherit" });
  if (cloned.error) {
    process.stderr.write(
      `${status.err(`Could not start git: ${cloned.error.message}`)}\n`,
    );
    return 1;
  }
  if ((cloned.status ?? 1) !== 0) {
    process.stderr.write(
      `${status.err(`git clone failed (exit ${cloned.status ?? 1}).`)}\n`,
    );
    return cloned.status ?? 1;
  }

  const defaultDirectory =
    target.repoUrl
      .split("/")
      .pop()
      ?.replace(/\.git$/i, "") || project.name;
  const repoRoot = resolve(process.cwd(), destination || defaultDirectory);
  if (isKortixProject(repoRoot)) {
    saveClonedProjectLink(
      repoRoot,
      project,
      hostArg ?? located.located.hostName ?? activeHostName() ?? undefined,
      auth.api_base,
    );
    if (target.token) configureProjectGitAuth(repoRoot, target.repoUrl);
  }

  process.stdout.write(`${status.ok(`Cloned ${project.name}`)}\n`);
  return 0;
}

function requireAuth() {
  const auth = loadAuth();
  if (!auth?.token) {
    process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    return null;
  }
  return auth;
}

/** The account `projects ls` should be scoped to: the active account, falling
 *  back to the host's stored account id. Undefined lets the server pick its
 *  earliest-joined-account default (pre-feature behavior). */
function scopeAccountId(auth: Auth): string | undefined {
  return activeAccount()?.id ?? auth.account_id ?? undefined;
}

/** Client-side `--query` filter. `GET /projects` has no server-side search, so
 *  the CLI narrows the list it already fetched — name, id and repo url, case
 *  insensitive. */
function filterProjects(projects: ProjectSummary[], query?: string): ProjectSummary[] {
  const q = query?.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((p) =>
    [p.name, p.project_id, p.repo_url].some((f) => (f ?? '').toLowerCase().includes(q)),
  );
}

async function projectsLs(
  json = false,
  all = false,
  query?: string,
  hostArg?: string,
  accountArg?: string,
): Promise<number> {
  // --host names a logged-in host other than the active one; --account picks
  // the account within it (default: that host's active account).
  const auth = hostArg ? loadAuthForHost(hostArg) : requireAuth();
  if (!auth?.token) {
    if (hostArg) {
      process.stderr.write(
        `${status.err(`Host "${hostArg}" is not logged in.`)} Run ${C.cyan}kortix login --host ${hostArg}${C.reset}.\n`,
      );
    }
    return 1;
  }
  if (all) return projectsLsAll(auth, json, query);

  // Scope to the active account so this lists exactly that account's projects
  // (not the server's earliest-joined-account default).
  // --host: that host's own stored account (never the global active one).
  const accountId = accountArg || (hostArg ? auth.account_id || undefined : scopeAccountId(auth));
  const client = clientFromAuth(auth, { accountId });
  let projects: ProjectSummary[];
  try {
    projects = filterProjects(await client.get<ProjectSummary[]>('/projects'), query);
  } catch (err) {
    return surface(err);
  }

  if (json) {
    emitJson(projects);
    return 0;
  }

  const acct = activeAccount();
  const linked = loadLink()?.project_id;
  const def = defaultProject()?.project_id;

  process.stdout.write('\n');
  if (acct) {
    const label = acct.name
      ? `${C.bold}${acct.name}${C.reset} ${C.faded}(${acct.slug})${C.reset}`
      : `${C.bold}${acct.slug}${C.reset}`;
    process.stdout.write(`  ${C.dim}account  ${C.reset}${label}\n\n`);
  }

  if (projects.length === 0) {
    process.stdout.write(
      query
        ? `  ${C.dim}No projects in this account match "${query}".${C.reset}\n\n`
        : `  ${C.dim}No projects in this account.${C.reset}\n\n`,
    );
    return 0;
  }

  renderProjectTable(projects, { linked, def });
  process.stdout.write(
    `\n  ${C.dim}${projects.length} project${projects.length === 1 ? '' : 's'}` +
      `${acct ? ` in ${acct.name || acct.slug}` : ''} · spans all accounts: ${C.reset}` +
      `${C.cyan}kortix projects ls --all${C.reset}\n\n`,
  );
  return 0;
}

async function projectsLsAll(auth: Auth, json = false, query?: string): Promise<number> {
  let me: MeResponse;
  try {
    me = await clientFromAuth(auth).get<MeResponse>('/accounts/me');
  } catch (err) {
    return surface(err);
  }

  const activeId = activeAccount()?.id ?? auth.account_id;
  const linked = loadLink()?.project_id;
  const def = defaultProject()?.project_id;

  const sections: { account: AccountMembership; projects: ProjectSummary[] }[] = [];
  for (const a of me.accounts) {
    let projects: ProjectSummary[] = [];
    try {
      projects = await clientFromAuth(auth, { accountId: a.account_id }).get<ProjectSummary[]>(
        '/projects',
      );
    } catch {
      /* skip accounts we can't read; leave the section empty */
    }
    sections.push({ account: a, projects: filterProjects(projects, query) });
  }

  if (json) {
    emitJson(
      sections.map((s) => ({
        account: {
          account_id: s.account.account_id,
          slug: s.account.slug,
          name: s.account.name,
          role: s.account.role,
          active: s.account.account_id === activeId,
        },
        projects: s.projects,
      })),
    );
    return 0;
  }

  let total = 0;
  for (const s of sections) {
    const activeMark =
      s.account.account_id === activeId ? `   ${C.green}← active${C.reset}` : '';
    process.stdout.write('\n');
    process.stdout.write(
      `  ${C.bold}${s.account.name || s.account.slug}${C.reset} ${C.faded}(${s.account.slug}, ${s.account.role})${C.reset}${activeMark}\n`,
    );
    if (s.projects.length === 0) {
      process.stdout.write(`  ${C.dim}— no projects${C.reset}\n`);
      continue;
    }
    renderProjectTable(s.projects, { linked, def });
    total += s.projects.length;
  }
  process.stdout.write(
    `\n  ${C.dim}${total} project${total === 1 ? '' : 's'} across ${me.accounts.length} ` +
      `account${me.accounts.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

/** Render a project table. `●` marks the global default, `◆` the cwd's
 *  directory link; a trailing tag spells it out. */
function renderProjectTable(
  projects: ProjectSummary[],
  marks: { linked?: string; def?: string },
): void {
  const nameW = Math.max(...projects.map((p) => p.name.length), 4);
  process.stdout.write(
    `  ${C.dim}${pad('NAME', nameW)}   ${pad('REPO', 40)}   BRANCH    UPDATED${C.reset}\n`,
  );
  for (const p of projects) {
    const isDefault = p.project_id === marks.def;
    const isLinked = p.project_id === marks.linked;
    const marker = isDefault
      ? `${C.green}● ${C.reset}`
      : isLinked
        ? `${C.cyan}◆ ${C.reset}`
        : '  ';
    const tag = isDefault
      ? `   ${C.green}default${C.reset}`
      : isLinked
        ? `   ${C.cyan}linked${C.reset}`
        : '';
    const repo = trimMid(p.repo_url, 40);
    const updated = formatRelative(p.updated_at);
    process.stdout.write(
      `${marker}${pad(p.name, nameW)}   ${pad(repo, 40)}   ${pad(p.default_branch, 8)}  ${C.faded}${updated}${C.reset}${tag}\n`,
    );
  }
}

async function projectsInfo(arg?: string, json = false, hostArg?: string): Promise<number> {
  const id = arg ?? resolveProjectId();
  if (!id) {
    process.stderr.write(
      `${status.err('No project linked. Run `kortix projects link` or pass an id.')}\n`,
    );
    return 1;
  }
  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix projects info ${id} --host ${host}`,
  );
  if (!located) return 1;
  const p = located.located.project;
  if (json) {
    emitJson(p);
    return 0;
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${p.name}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}project_id ${C.reset}${p.project_id}\n`);
  process.stdout.write(`  ${C.dim}account_id ${C.reset}${p.account_id}\n`);
  process.stdout.write(`  ${C.dim}repo       ${C.reset}${p.repo_url}\n`);
  process.stdout.write(`  ${C.dim}branch     ${C.reset}${p.default_branch}\n`);
  process.stdout.write(`  ${C.dim}manifest   ${C.reset}${p.manifest_path}\n`);
  process.stdout.write(`  ${C.dim}status     ${C.reset}${p.status}\n`);
  process.stdout.write(`  ${C.dim}updated    ${C.reset}${formatRelative(p.updated_at)}\n\n`);
  return 0;
}

async function projectsUse(arg?: string): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;

  let target: ProjectSummary | null = null;
  if (arg) {
    // An explicit id may live in any account — resolve it unscoped.
    try {
      target = await clientFromAuth(auth).get<ProjectSummary>(`/projects/${arg}`);
    } catch (err) {
      return surface(err);
    }
  } else {
    // Pick from the active account's projects.
    let list: ProjectSummary[];
    try {
      list = await clientFromAuth(auth, { accountId: scopeAccountId(auth) }).get<ProjectSummary[]>(
        '/projects',
      );
    } catch (err) {
      return surface(err);
    }
    if (list.length === 0) {
      process.stderr.write(
        `${status.err('No projects in the active account.')} Switch with \`kortix accounts use\`.\n`,
      );
      return 1;
    }
    const picked = await selectFromList<ProjectSummary>({
      title: 'Set the global default project',
      items: list.map((p) => ({ value: p, label: p.name, sublabel: p.project_id })),
    });
    if (!picked) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
    target = picked;
  }

  if (!target) {
    process.stderr.write(`${status.err('Could not resolve a project.')}\n`);
    return 1;
  }

  // A default project pins its account. If it lives in a different account
  // than the active one, switch the active account to it (resolving the
  // account's display name best-effort) before recording the default.
  const switched = target.account_id !== (activeAccount()?.id ?? auth.account_id);
  let accountLabel = target.account_id.slice(0, 8);
  if (switched) {
    let slug = target.account_id.slice(0, 8);
    let name: string | undefined;
    try {
      const me = await clientFromAuth(auth).get<MeResponse>('/accounts/me');
      const m = me.accounts.find((a) => a.account_id === target!.account_id);
      if (m) {
        slug = m.slug;
        name = m.name;
      }
    } catch {
      /* fall back to the truncated id */
    }
    setActiveAccount({ id: target.account_id, slug, name });
    accountLabel = name ? `${name} (${slug})` : slug;
  }
  setDefaultProject({
    project_id: target.project_id,
    account_id: target.account_id,
    name: target.name,
  });

  process.stdout.write(`${status.ok(`Default project: ${C.bold}${target.name}${C.reset}`)}\n`);
  if (switched) {
    process.stdout.write(`  ${C.dim}account → ${C.reset}${accountLabel} ${C.dim}(now active)${C.reset}\n`);
  }
  process.stdout.write(
    `  ${C.dim}Used by connectors/connections/sessions when a directory isn't linked.${C.reset}\n`,
  );
  return 0;
}

async function projectsUnset(): Promise<number> {
  const existing = defaultProject();
  if (clearDefaultProject()) {
    process.stdout.write(
      `${status.ok(`Cleared the default project${existing?.name ? ` ${C.dim}(was ${existing.name})${C.reset}` : ''}`)}\n`,
    );
  } else {
    process.stdout.write(`${C.dim}No default project set. Nothing to do.${C.reset}\n`);
  }
  return 0;
}

async function projectsLink(arg?: string): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;

  // Refuse to scatter `.kortix/link.json` into random directories. A
  // project is only "Kortix-linkable" if it already has a `.kortix/`
  // dir (from `kortix init`) or a `kortix.yaml` at the root.
  if (!isKortixProject()) {
    process.stderr.write(
      `${status.err(`Not a Kortix project — no .kortix/ or kortix.yaml in ${process.cwd()}.`)}\n`,
    );
    process.stderr.write(
      `  ${C.dim}Run ${C.reset}${C.cyan}kortix init${C.reset}${C.dim} here first to scaffold one.${C.reset}\n`,
    );
    return 1;
  }

  const client = clientFromAuth(auth);

  let target: ProjectSummary | null = null;
  if (arg) {
    try {
      target = await client.get<ProjectSummary>(`/projects/${arg}`);
    } catch (err) {
      return surface(err);
    }
  } else {
    let list: ProjectSummary[];
    try {
      list = await client.get<ProjectSummary[]>('/projects');
    } catch (err) {
      return surface(err);
    }
    if (list.length === 0) {
      process.stderr.write(`${status.err('No projects in this account to link to.')}\n`);
      return 1;
    }
    const picked = await selectFromList<ProjectSummary>({
      title: `Pick a project to link to ${process.cwd()}`,
      items: list.map((p) => ({
        value: p,
        label: p.name,
        sublabel: p.project_id,
      })),
    });
    if (!picked) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
    target = picked;
  }

  if (!target) {
    process.stderr.write(`${status.err('Could not resolve a project.')}\n`);
    return 1;
  }

  const hostName = activeHostName() ?? 'default';
  saveLink({
    project_id: target.project_id,
    account_id: target.account_id,
    host: hostName,
    host_url: auth.api_base,
    linked_at: new Date().toISOString(),
  });
  process.stdout.write(
    `${status.ok(`Linked ${C.bold}${target.name}${C.reset}${C.dim} → .kortix/link.json${C.reset}`)}\n`,
  );
  process.stdout.write(
    `  ${C.dim}host:       ${C.reset}${hostName} ${C.faded}(${auth.api_base})${C.reset}\n`,
  );
  process.stdout.write(`  ${C.dim}project_id: ${C.reset}${target.project_id}\n`);
  return 0;
}

async function projectsUnlink(): Promise<number> {
  const existing = loadLink();
  clearLink();
  if (existing) {
    process.stdout.write(`${status.ok(`Unlinked ${C.dim}(was ${existing.project_id})${C.reset}`)}\n`);
  } else {
    process.stdout.write(`${C.dim}Not linked. Nothing to do.${C.reset}\n`);
  }
  return 0;
}

async function projectsOpen(arg?: string, hostArg?: string): Promise<number> {
  const id = arg ?? resolveProjectId();
  if (!id) {
    process.stderr.write(`${status.err('No project linked. Pass an id or link first.')}\n`);
    return 1;
  }
  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix projects open ${id} --host ${host}`,
  );
  if (!located) return 1;
  const url = projectWebUrl(located.located.auth.api_base, id);
  process.stdout.write(`${C.dim}Opening ${url}${C.reset}\n`);
  openInBrowser(url);
  return 0;
}

interface RmResult {
  ok: boolean;
  archived: boolean;
  repo_deleted: boolean;
}

async function projectsRm(args: string[]): Promise<number> {
  const rest = [...args];
  const purge = takeFlagBool(rest, ['--purge']);
  const yes = takeFlagBool(rest, ['-y', '--yes']);
  let hostArg: string | undefined;
  try {
    hostArg = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const id = rest.find((a) => !a.startsWith('-')) ?? resolveProjectId();
  if (!id) {
    process.stderr.write(
      `${status.err('No project to remove.')} Pass an id or run inside a linked project.\n`,
    );
    return 1;
  }

  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix projects rm ${id} --host ${host}`,
  );
  if (!located) return 1;
  const { client, project } = located.located;

  if (!yes) {
    const msg = purge
      ? `Archive ${C.bold}${project.name}${C.reset} AND permanently delete its managed git repo? ${C.red}This cannot be undone.${C.reset}`
      : `Archive ${C.bold}${project.name}${C.reset}? (the git repo is kept; pass --purge to delete it)`;
    const ok = await confirm(msg, false);
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }

  let result: RmResult;
  try {
    result = await client.delete<RmResult>(`/projects/${id}${purge ? '?purge=true' : ''}`);
  } catch (err) {
    return surface(err);
  }

  // Drop the local binding if we just removed the linked project.
  if (loadLink()?.project_id === id) clearLink();

  process.stdout.write(`${status.ok(`Archived ${C.bold}${project.name}${C.reset}`)}\n`);
  if (purge) {
    process.stdout.write(
      result.repo_deleted
        ? `  ${C.dim}managed git repo deleted${C.reset}\n`
        : `  ${C.dim}no managed repo to delete (bring-your-own repos are left untouched)${C.reset}\n`,
    );
  }
  return 0;
}

// ── helpers ────────────────────────────────────────────────────────────────

function surface(err: unknown): number {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      process.stderr.write(
        `${status.err('Token rejected. Run `kortix login` to re-authenticate.')}\n`,
      );
    } else {
      process.stderr.write(`${status.err(`HTTP ${err.status}: ${err.message}`)}\n`);
    }
    return 1;
  }
  process.stderr.write(`${status.err((err as Error).message)}\n`);
  return 1;
}

function trimMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
