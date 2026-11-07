import { resolve } from 'node:path';
import { PROJECT_GLYPH_COLORS, isProjectGlyphName, normalizeProjectGlyphColor } from '@kortix/shared';
import { loadAuth, loadAuthForHost } from '../api/auth.ts';
import type { Auth } from '../api/auth.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import {
  activeAccount,
  activeHostName,
  clearDefaultProject,
  defaultProject,
  getHost,
  setActiveAccount,
  setDefaultProject,
} from '../api/config.ts';
import type { AccountMembership, MeResponse, ProjectSummary } from '../api/types.ts';
import { openInBrowser } from '../browser.ts';
import {
  NO_WORKSPACE_LINE,
  emitJson,
  isNoWorkspaceError,
  locateProjectAnywhere,
  noWorkspace,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  tokenRejectedLine,
} from '../command-helpers.ts';
import { appendGitExcludeEntries } from '../git-exclude.ts';
import { authGitEnv } from '../git-ops.ts';
import { runGit } from '../git-run.ts';
import { configureProjectGitAuth, resolveProjectGitTarget } from '../project-git.ts';
import {
  clearLink,
  isKortixProject,
  loadLink,
  resolveProjectId,
  saveLink,
} from '../project-link.ts';
import { listWorkspaceRowsReport, type WorkspaceListFailure, type WorkspaceRow } from '../project-bind.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';
import { selectFromList } from '../tui-select.ts';
import { projectWebUrl } from '../web-url.ts';
import { settingsWhere } from '../settings-path.ts';

/** Back-compat alias — the helper moved to ../project-git.ts so `ship` can use
 *  it without an import cycle through this command module. */
export {
  configureProjectGitAuth as configureClonedProjectAuth,
  currentGitCredentialHelperCommand,
} from '../project-git.ts';

const HELP = help`Usage: kortix workspaces <subcommand> [options]

A workspace is one company's Kortix: its people, agents, sessions, secrets,
connectors, billing and config repo. You can belong to several workspaces;
one is the default, and a linked directory (.kortix/link.json) overrides it.

Subcommands:
  create <name>        Create a workspace; prints its id (--json).
                       --host <name> selects the host. Then run
                       workspaces use <id> to select it.
                       --account <id>: Deprecated. Adds a second project to
                       that account instead of creating a workspace.
  ls                   List every workspace you belong to. --query <text>
                       filters by name, id or repo. (--json)
                       --account <id>: Deprecated. Lists one account's.
                       --all: Deprecated. The older view, grouped by account.
  info [<id>]          Show one workspace (defaults to the linked/default) (--json)
  set [<id>]           Update name, branch, manifest path or icon.
  rename [<id>] <name> Alias for \`workspaces set --name <name>\`.
  cli-tokens ls|new|rm Workspace CLI tokens (kortix_pat_…).
  use [<id>]           Set the global DEFAULT workspace (interactive if omitted).
                       --host <name> binds that logged-in host's default
                       instead of the active one.
  unset                Clear the global default workspace. --host <name> clears
                       that host's instead.
  link [<id>]          Bind cwd to a workspace (writes .kortix/link.json).
                       --host <name> binds a workspace on that logged-in host,
                       authenticating with its stored key.
  unlink               Remove .kortix/link.json from cwd
  open [<id>]          Open one workspace in the browser
  clone [<id>] [dir]   Clone the workspace's config repo through the
                       authenticated Kortix git proxy. Falls back to your local
                       Git credentials for direct BYO repos.
  rm [<id>]            Delete a workspace and its Kortix-managed git repo
                       (defaults to the linked one). Repositories you
                       connected yourself are never touched.
                       -y / --yes skips the confirmation.
  features [ls]        List every feature flag with its effective state for the
                       workspace (${settingsWhere('feature-flags')}). (--json)
  features enable <flag>   Turn a flag on for the workspace.
  features disable <flag>  Turn a flag off for the workspace.
  features reset <flag>    Clear the workspace's override (follow the default).
                       features takes --workspace <id>; defaults to linked/default.

An explicit <id> on info/open/rm resolves on its own: tries the active host
first, then — unless you pass --host — scans every other logged-in host for
it. A directory link (.kortix/link.json) always wins over the default; the
default is what commands use anywhere else on your machine.

The workspace id is the project_id field of --json output. kortix projects
is the older name of this command and still works. So do --project <id> and
KORTIX_PROJECT_ID (KORTIX_WORKSPACE_ID wins when both are set).

Examples:
  kortix workspaces create "Acme"
  kortix workspaces ls
  kortix workspaces use 3f2a9c1e-…
`;

export interface RunProjectsOptions {
  /** Invoked as `kortix projects` / `project`, the older name. `ls` then
   *  prints exactly what it printed before Workspaces: the active account's
   *  projects. Scripts parse that output. */
  olderName?: boolean;
}

export async function runProjects(argv: string[], options: RunProjectsOptions = {}): Promise<number> {
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
  ]);
  if ((rest.includes('-h') || rest.includes('--help')) && !OWNS_HELP.has(sub)) {
    process.stdout.write(HELP);
    return 0;
  }
  switch (sub) {
    case 'create':
      return projectsCreate(rest);
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
      if (options.olderName) return projectsLsOlder(json, all, query, hostArg, accountArg);
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
    case 'info': {
      const restCopy = [...rest];
      const json = takeFlagBool(restCopy, ['--json']);
      let hostArg: string | undefined;
      let idFlag: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
        // `info --workspace <id>` (and the older `--project <id>`) name the
        // same id the positional does; without this the flag itself was
        // read as the id.
        idFlag = takeFlagValue(restCopy, ['--project']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsInfo(idFlag ?? restCopy[0], json, hostArg);
    }
    case 'use':
    case 'default': {
      const restCopy = [...rest];
      let hostArg: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsUse(
        restCopy.find((a) => !a.startsWith('-')),
        hostArg,
      );
    }
    case 'unset':
    case 'clear': {
      const restCopy = [...rest];
      let hostArg: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsUnset(hostArg);
    }
    case 'link': {
      const restCopy = [...rest];
      let hostArg: string | undefined;
      try {
        hostArg = takeFlagValue(restCopy, ['--host']);
      } catch (err) {
        process.stderr.write(`${status.err((err as Error).message)}\n`);
        return 2;
      }
      return projectsLink(restCopy.find((a) => !a.startsWith('-')), hostArg);
    }
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

// ── Feature flags (Workspace settings → Feature flags) ───────────────────────────────

const FEATURES_HELP = help`Usage: kortix workspaces features [ls | enable | disable | reset] [<flag>]

Workspace feature flags — the same switches as ${settingsWhere('feature-flags')}.
A flag is a stable key (e.g. monitors, event_triggers). State is
stored on the workspace, never in kortix.yaml.

Subcommands:
  ls                    List every flag: key, state, origin. (--json)
  enable <flag>         Set the workspace override to ON.
  disable <flag>        Set the workspace override to OFF.
  reset <flag>          Remove the override; the flag follows the platform default.

Options:
  --workspace <id>      Act on this workspace (default: linked/default).
                        --project <id> is the older name.
  --host <name>         Use this logged-in host.
  --json                Machine-readable output.

Requires project.settings.write. A flag the platform marks unavailable stays
off regardless of the workspace override.

Internal-only flags are listed only while they are on, with origin "kortix".
Only Kortix changes them: enable, disable and reset are refused. Contact
Kortix to change one.
`;

interface FeatureFlagRow {
  key: string;
  name: string;
  description: string;
  stability: string;
  available: boolean;
  enabled: boolean;
  overridden: boolean;
  /** Internal-only flag: listed only while on, changed only by Kortix. */
  operator_only?: boolean;
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
    const origin = !r.available
      ? 'unavailable'
      : r.operator_only
        ? 'kortix'
        : r.overridden
          ? 'override'
          : 'default';
    process.stdout.write(`  ${pad(r.key, keyW)}  ${state}  ${pad(origin, 10)}  ${r.name}\n`);
  }
  if (rows.some((r) => r.operator_only)) {
    process.stdout.write(`\n  ${C.dim}origin kortix: enabled by Kortix for this workspace. Contact Kortix to change it.${C.reset}\n`);
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
      const project = await client.get<Record<string, unknown>>(`/workspaces/${projectId}`);
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

  if (
    sub === 'enable' ||
    sub === 'on' ||
    sub === 'disable' ||
    sub === 'off' ||
    sub === 'reset' ||
    sub === 'clear'
  ) {
    if (!flag) {
      process.stderr.write(
        `${status.err(`features ${sub} requires a <flag>.`)}\n\n${FEATURES_HELP}`,
      );
      return 2;
    }
    const enabled =
      sub === 'enable' || sub === 'on' ? true : sub === 'disable' || sub === 'off' ? false : null;
    try {
      const project = await client.patch<Record<string, unknown>>(
        `/workspaces/${projectId}/features`,
        {
          feature: flag,
          enabled,
        },
      );
      const row = featureRows(project).find((r) => r.key === flag);
      if (json) {
        emitJson(row ?? { key: flag, enabled });
        return 0;
      }
      const verb = enabled === null ? 'reset to default' : enabled ? 'enabled' : 'disabled';
      const effective = row
        ? row.available
          ? row.enabled
            ? 'on'
            : 'off'
          : 'unavailable on this host'
        : '?';
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
  const color = normalizeProjectGlyphColor(raw.slice(at + 1));
  if (!isProjectGlyphName(name) || !color) return null;
  return { name, color };
}

/** `serializeProject`'s icon fields, which `ProjectSummary` does not carry. */
interface ProjectWithIcon extends ProjectSummary {
  icon?: string | null;
  icon_glyph?: { name: string; color: string } | null;
}

// ── Settings → General (name / branch / manifest / icon) ───────────────────

const SET_HELP = help`Usage: kortix workspaces set [<id>] [options]

Update one workspace's settings — the dashboard's ${settingsWhere('general')}
(PATCH /workspaces/:id). Only the fields you pass are written.

Options:
  --name <name>          Display name.
  --branch <branch>      Default branch.
  --manifest <path>      Manifest path, e.g. kortix.yaml.
  --icon <emoji>         Set the workspace emoji.
  --no-icon              Remove the emoji.
  --glyph <name>:<color> Set the workspace glyph, e.g. Rocket:blue.
                         Colors: ${PROJECT_GLYPH_COLORS.join(', ')}, or #rrggbb.
  --no-glyph             Remove the glyph.
  --workspace <id>       Act on this workspace (default: linked/default).
                         --project <id> is the older name.
  --host <name>          Use this logged-in host.
  --json                 Emit the updated workspace as JSON.
  -h, --help             Show this help.

Requires project.settings.write. The icon fields are three-state: omit to
leave as-is, --no-icon / --no-glyph to remove. A workspace shows ONE icon, so
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
    project = await ctx.client.patch<ProjectWithIcon>(`/workspaces/${ctx.projectId}`, req.body);
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
      `${status.err('Pass --icon or --glyph, not both — a workspace shows one icon.')}\n`,
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
          `  ${C.dim}colors: ${PROJECT_GLYPH_COLORS.join(', ')}, or #rrggbb${C.reset}\n`,
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

// ── Workspace CLI tokens ──────────────────────────────────────────────

/** The API hides session-bound tokens from the CLI token list (they are the
 *  runtime's per-session KORTIX_TOKEN, minted and revoked with the session —
 *  a person never creates one). The count keeps their provenance visible
 *  instead of a silent hole in the list. */
function writeSessionTokenNote(count: number): void {
  if (count <= 0) return;
  process.stdout.write(
    `${C.dim}  Not listed: ${count} session token${count === 1 ? '' : 's'} — minted by the runtime, one per session (the sandbox's KORTIX_TOKEN); each lives and dies with its session.${C.reset}\n`,
  );
}

const CLI_TOKENS_HELP = help`Usage: kortix workspaces cli-tokens [ls | new | rm <token-id>] [options]

Workspace CLI tokens (kortix_pat_…). A token is bound to ONE workspace —
the API rejects it on every other workspace. Session sandboxes use their
session-bound KORTIX_TOKEN instead.

Subcommands:
  ls                   List this workspace's CLI tokens. Session tokens are not
                       listed (the count below the table). (--json)
  new                  Mint one. The secret is printed ONCE and never again.
  rm <token-id>        Revoke one.

Options:
  --name <name>        new: label (default: "cli · <workspace name>").
  --expires-at <iso>   new: expiry (ISO-8601). Required when the workspace's
                       PAT policy requires an expiry.
  --workspace <id>     Act on this workspace (default: linked/default).
                       --project <id> is the older name.
  --host <name>        Use this logged-in host.
  --json               Machine-readable output.
  -y, --yes            rm: skip the confirmation.
  -h, --help           Show this help.

ls, new and rm need project.credentials.issue: the list names every member's
workspace tokens. A session-bound token can neither mint nor revoke workspace
tokens (403). The workspace's PAT policy (require expiry, maximum lifetime)
applies to new tokens.
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

/** `session_tokens` is absent from an older API's answer; treat that as 0. */
interface CliTokenList {
  items: CliTokenRow[];
  session_tokens?: number;
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
  let expiresAt: string | undefined;
  let json = false;
  let yes = false;
  try {
    projectArg = takeFlagValue(rest, ['--project', '-p']);
    hostArg = takeFlagValue(rest, ['--host']);
    tokenName = takeFlagValue(rest, ['--name']);
    expiresAt = takeFlagValue(rest, ['--expires-at']);
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
  const path = `/workspaces/${ctx.projectId}/cli-token`;

  if (sub === 'ls' || sub === 'list') {
    try {
      const { items, session_tokens: sessionTokens = 0 } = await ctx.client.get<CliTokenList>(path);
      if (json) {
        emitJson(items);
        return 0;
      }
      if (items.length === 0) {
        process.stdout.write(`${status.info('No CLI tokens in this workspace.')}\n`);
        writeSessionTokenNote(sessionTokens);
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
      process.stdout.write(`\n  ${C.dim}${items.length} token${items.length === 1 ? '' : 's'}${C.reset}\n`);
      writeSessionTokenNote(sessionTokens);
      process.stdout.write('\n');
      return 0;
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  if (sub === 'new' || sub === 'create') {
    let created: CreatedCliToken;
    try {
      created = await ctx.client.post<CreatedCliToken>(path, {
        ...(tokenName ? { name: tokenName } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      });
    } catch (err) {
      return surfaceApiError(err);
    }
    if (json) {
      emitJson(created);
      return 0;
    }
    process.stdout.write(`${status.ok(`Minted ${C.bold}${created.name}${C.reset}`)}\n`);
    process.stdout.write(`  ${C.dim}token_id ${C.reset}${created.token_id}\n`);
    process.stdout.write(`  ${C.dim}workspace ${C.reset}${created.project_id}\n`);
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

interface ProjectCloneTarget {
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
  const existing = loadLink(repoRoot);
  if (
    existing?.project_id !== project.project_id ||
    existing.account_id !== project.account_id ||
    existing.host !== host ||
    existing.host_url !== hostUrl
  ) {
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
  }

  appendGitExcludeEntries(repoRoot, ['/.kortix/link.json'], 'Kortix local workspace binding');
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
    token: target.credentialMode === 'kortix-token' ? kortixToken : null,
    username: 'x-access-token',
    needsManagedToken: target.credentialMode === 'managed-git-token',
  };
}

async function projectsClone(
  arg?: string,
  destination?: string,
  hostArg?: string,
): Promise<number> {
  const id = resolveProjectId(arg, { hostScoped: !hostArg, hostArg });
  if (!id) {
    process.stderr.write(
      `${status.err('No workspace selected. Run `kortix workspaces use`, link a directory, or pass an id.')}\n`,
    );
    return 1;
  }

  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix workspaces clone ${id} --host ${host}`,
  );
  if (!located) return 1;

  const { client, auth, project } = located.located;
  const target = resolveProjectCloneTarget(project, auth.token);
  if (target.needsManagedToken) {
    try {
      const credential = await client.post<{
        push_token: string;
        git_username?: string;
      }>(`/workspaces/${project.project_id}/git-token`);
      target.token = credential.push_token;
      target.username = credential.git_username || target.username;
    } catch (err) {
      return surface(err);
    }
  }

  const args = ['clone', target.repoUrl];
  if (destination) args.push(destination);

  const cloned = runGit(undefined, args, {
    inheritStdio: true,
    // The token travels in the environment, never in argv (see `authGitEnv`).
    env: target.token ? authGitEnv(target.repoUrl, target.token, target.username) : undefined,
  });
  if (cloned.error) {
    process.stderr.write(`${status.err(`Could not start git: ${cloned.error.message}`)}\n`);
    return 1;
  }
  if (!cloned.ok) {
    process.stderr.write(`${status.err(`git clone failed (exit ${cloned.code}).`)}\n`);
    return cloned.code;
  }

  const defaultDirectory =
    target.repoUrl
      .split('/')
      .pop()
      ?.replace(/\.git$/i, '') || project.name;
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

/**
 * `workspaces create <name>`: one call creates a whole workspace (decision D1,
 * "1 account = 1 workspace"). The body carries `new_workspace: true` and no
 * account: the API reuses the newest account the caller owns that has no
 * project yet (so a plan or credits it holds stay), else creates one, then
 * provisions its project. `--account <id>` is the older behavior, kept for
 * scripts: it adds a project to that existing account.
 */
async function projectsCreate(argv: string[]): Promise<number> {
  const rest = [...argv];
  const json = takeFlagBool(rest, ['--json']);
  let hostArg: string | undefined;
  let accountArg: string | undefined;
  try {
    hostArg = takeFlagValue(rest, ['--host']);
    accountArg = takeFlagValue(rest, ['--account']);
  } catch (err) {
    process.stderr.write(`${status.err(err instanceof Error ? err.message : String(err))}\n`);
    return 2;
  }
  const name = rest[0]?.trim();
  if (rest.length !== 1 || !name || name.startsWith('-') || hostArg === '' || accountArg === '') {
    process.stderr.write('Usage: kortix workspaces create <name> [--host <name>] [--json]\n');
    return 2;
  }
  const auth = hostArg ? loadAuthForHost(hostArg) : requireAuth();
  if (!auth?.token) {
    if (hostArg) process.stderr.write(`${status.err(`Host "${hostArg}" is not logged in.`)}\n`);
    return 1;
  }
  const body: Record<string, unknown> = accountArg
    ? { name, account_id: accountArg }
    : { name, new_workspace: true };
  try {
    // Legacy-only route: provision and link-repository have no /v1/workspaces name
    // (WORKSPACE_LEGACY_ONLY_ROUTES); POST /v1/workspaces is the new-workspace create.
    const project = await clientFromAuth(auth, { accountId: accountArg }).post<ProjectSummary>(
      '/projects/provision',
      body,
    );
    if (!isDefaultProjectResponse(project)) return invalidDefaultProjectResponse(project);
    // Provisioning also returns a one-time push credential. Never print it.
    if (json) emitJson({ project_id: project.project_id, name: project.name, account_id: project.account_id });
    else process.stdout.write(`${project.project_id}\n`);
    return 0;
  } catch (err) {
    return surface(err);
  }
}

/** Every workspace on one host, flat (see listWorkspaceRowsReport). Returns
 *  the exit code when the read fails. */
async function listWorkspaces(
  auth: Auth,
  accountId?: string,
): Promise<{ rows: WorkspaceRow[]; failed: WorkspaceListFailure[] } | number> {
  try {
    return await listWorkspaceRowsReport(auth, accountId);
  } catch (err) {
    return surface(err);
  }
}

/** Name each account whose list failed (stderr). The caller exits 1: a
 *  failed read never looks like an account with no workspace. */
function writeListFailures(failed: WorkspaceListFailure[]): void {
  for (const { account, error } of failed) {
    const reason = error instanceof ApiError ? `HTTP ${error.status}: ${error.message}` : String((error as Error)?.message ?? error);
    process.stderr.write(
      `${status.err(`Could not list the workspaces of account ${account.name || account.slug} (${account.slug}): ${reason}`)}\n`,
    );
  }
}

/** The line every empty workspace list prints (stdout, exit 0). */
function writeNoWorkspaceYet(): void {
  process.stdout.write(`  ${C.dim}${NO_WORKSPACE_LINE}${C.reset}\n\n`);
}

async function projectsLs(
  json = false,
  all = false,
  query?: string,
  hostArg?: string,
  accountArg?: string,
): Promise<number> {
  // --host names a logged-in host other than the active one.
  const auth = hostArg ? loadAuthForHost(hostArg) : requireAuth();
  if (!auth?.token) {
    if (hostArg) {
      process.stderr.write(
        `${status.err(`Host "${hostArg}" is not logged in.`)} Run ${C.cyan}kortix login --host ${hostArg}${C.reset}.\n`,
      );
    }
    return 1;
  }
  // Deprecated: the older grouped-by-account view and its JSON shape.
  if (all) return projectsLsAll(auth, json, query);

  const report = await listWorkspaces(auth, accountArg || undefined);
  if (typeof report === 'number') return report;
  const { rows: listed, failed } = report;
  writeListFailures(failed);
  const exitCode = failed.length > 0 ? 1 : 0;
  const q = query?.trim().toLowerCase();
  const rows = q
    ? listed.filter(({ project: p }) =>
        [p.name, p.project_id, p.repo_url].some((f) => (f ?? '').toLowerCase().includes(q)),
      )
    : listed;

  if (json) {
    // The API's own rows, flat — the same element shape `projects ls --json`
    // always printed.
    emitJson(rows.map((r) => r.project));
    return exitCode;
  }

  process.stdout.write('\n');
  if (rows.length === 0) {
    if (query && listed.length > 0) {
      process.stdout.write(`  ${C.dim}No workspace matches "${query}".${C.reset}\n\n`);
    } else if (failed.length === 0) {
      // Only a complete read may say none exists.
      writeNoWorkspaceYet();
    }
    return exitCode;
  }

  renderWorkspaceTable(rows, { linked: loadLink()?.project_id, def: defaultProject()?.project_id });
  process.stdout.write(
    `\n  ${C.dim}${rows.length} workspace${rows.length === 1 ? '' : 's'} · ` +
      `switch with ${C.reset}${C.cyan}kortix workspaces use <id>${C.reset}\n\n`,
  );
  return exitCode;
}

/** Render the flat workspace table. `●` marks the global default, `◆` the
 *  cwd's directory link; a trailing tag spells it out. */
function renderWorkspaceTable(rows: WorkspaceRow[], marks: { linked?: string; def?: string }): void {
  const nameW = Math.max(...rows.map((r) => r.project.name.length), 4);
  const roleW = Math.max(...rows.map((r) => r.account.role.length), 4);
  process.stdout.write(
    `  ${C.dim}${pad('NAME', nameW)}   ${pad('ID', 36)}   ${pad('ROLE', roleW)}   UPDATED${C.reset}\n`,
  );
  for (const { project: p, account } of rows) {
    const isDefault = p.project_id === marks.def;
    const isLinked = p.project_id === marks.linked;
    const marker = isDefault ? `${C.green}● ${C.reset}` : isLinked ? `${C.cyan}◆ ${C.reset}` : '  ';
    const state =
      p.state === 'setup_required'
        ? `   ${C.yellow}set up needed${C.reset}`
        : p.state === 'deleting'
          ? `   ${C.yellow}deleting${C.reset}`
          : '';
    const tag =
      (isDefault
        ? `   ${C.green}default${C.reset}`
        : isLinked
          ? `   ${C.cyan}linked${C.reset}`
          : '') + state;
    process.stdout.write(
      `${marker}${pad(p.name, nameW)}   ${pad(p.project_id, 36)}   ${C.faded}${pad(account.role, roleW)}${C.reset}   ${C.faded}${formatRelative(p.updated_at)}${C.reset}${tag}\n`,
    );
  }
}

/**
 * `kortix projects ls`, the older name: the code and output as they were
 * before Workspaces, unchanged. Scripts parse it. `kortix workspaces ls` is
 * the flat list across accounts.
 */
async function projectsLsOlder(
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
  if (all) return projectsLsAll(auth, json, query, true);

  // Scope to the active account so this lists exactly that account's projects
  // (not the server's earliest-joined-account default).
  // --host: that host's own stored account (never the global active one).
  const accountId = accountArg || (hostArg ? auth.account_id || undefined : scopeAccountId(auth));
  const client = clientFromAuth(auth, { accountId });
  let projects: ProjectSummary[];
  try {
    // GET /workspaces lists every workspace of the caller: keep the active
    // account's, which is what this older command has always listed.
    const every = await client.get<ProjectSummary[]>('/workspaces');
    projects = filterProjects(accountId ? every.filter((p) => p.account_id === accountId) : every, query);
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

async function projectsLsAll(auth: Auth, json = false, query?: string, olderName = false): Promise<number> {
  let me: MeResponse;
  try {
    me = await clientFromAuth(auth).get<MeResponse>('/me');
  } catch (err) {
    return surface(err);
  }

  const activeId = activeAccount()?.id ?? auth.account_id;
  const linked = loadLink()?.project_id;
  const def = defaultProject()?.project_id;

  // One read on a server that lists every workspace of the caller (an older
  // server: one read per account); each account section shows its own. An
  // account whose read failed keeps an empty section, as before.
  let rows: WorkspaceRow[] = [];
  try {
    rows = (await listWorkspaceRowsReport(auth, undefined, me)).rows;
  } catch (err) {
    return surface(err);
  }
  const sections: { account: AccountMembership; projects: ProjectSummary[] }[] = me.accounts.map((a) => ({
    account: a,
    projects: filterProjects(rows.filter((r) => r.project.account_id === a.account_id).map((r) => r.project), query),
  }));

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
    const activeMark = s.account.account_id === activeId ? `   ${C.green}← active${C.reset}` : '';
    process.stdout.write('\n');
    process.stdout.write(
      `  ${C.bold}${s.account.name || s.account.slug}${C.reset} ${C.faded}(${s.account.slug}, ${s.account.role})${C.reset}${activeMark}\n`,
    );
    if (s.projects.length === 0) {
      process.stdout.write(`  ${C.dim}— no ${olderName ? 'projects' : 'workspace'}${C.reset}\n`);
      continue;
    }
    renderProjectTable(s.projects, { linked, def });
    total += s.projects.length;
  }
  process.stdout.write(
    `\n  ${C.dim}${total} ${olderName ? 'project' : 'workspace'}${total === 1 ? '' : 's'} across ${me.accounts.length} ` +
      `account${me.accounts.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

/** The deprecated `ls --all` table, one account section at a time. `●` marks
 *  the global default, `◆` the cwd's directory link. */
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
    const marker = isDefault ? `${C.green}● ${C.reset}` : isLinked ? `${C.cyan}◆ ${C.reset}` : '  ';
    const state =
      p.state === 'setup_required'
        ? `   ${C.yellow}set up needed${C.reset}`
        : p.state === 'deleting'
          ? `   ${C.yellow}deleting${C.reset}`
          : '';
    const tag =
      (isDefault
        ? `   ${C.green}default${C.reset}`
        : isLinked
          ? `   ${C.cyan}linked${C.reset}`
          : '') + state;
    const repo = trimMid(p.repo_url, 40);
    const updated = formatRelative(p.updated_at);
    process.stdout.write(
      `${marker}${pad(p.name, nameW)}   ${pad(repo, 40)}   ${pad(p.default_branch, 8)}  ${C.faded}${updated}${C.reset}${tag}\n`,
    );
  }
}

interface GitConnectionState {
  state: 'connected' | 'reconnect_required' | 'unavailable' | 'not_connected';
  reason?: string;
  disconnected_reason?: string;
  message?: string;
  install_url?: string | null;
}

/** The `git` line of `projects info`, plus the cause and the fix when the repository is disconnected. */
export function gitConnectionLines(git: GitConnectionState): string {
  const label = `  ${C.dim}git        ${C.reset}`;
  if (git.state === 'connected') return `${label}connected\n`;
  if (git.state === 'not_connected') return `${label}not connected\n`;
  const why = git.disconnected_reason ?? git.reason;
  let out = `${label}${C.yellow}${git.disconnected_reason ? 'disconnected' : git.state.replace('_', ' ')}${why ? ` (${why})` : ''}${C.reset}\n`;
  if (git.message) out += `             ${git.message}\n`;
  if (git.install_url) out += `  ${C.dim}reconnect  ${C.reset}${git.install_url}\n`;
  return out;
}

async function projectsInfo(arg?: string, json = false, hostArg?: string): Promise<number> {
  const id = resolveProjectId(arg, { hostScoped: !hostArg, hostArg });
  if (!id) {
    process.stderr.write(
      `${status.err('No workspace selected. Run `kortix workspaces link` or pass an id.')}\n`,
    );
    return 1;
  }
  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix workspaces info ${id} --host ${host}`,
  );
  if (!located) return 1;
  const p = located.located.project;
  // Whether Kortix can reach the repository (KRTX-2955). Best effort: an
  // older server without the route prints no git line.
  const git = await located.located.client
    .get<GitConnectionState>(`/workspaces/${p.project_id}/git/connection`)
    .catch(() => null);
  if (json) {
    // The API's wire name for the id is `project_id`; scripts read `.id`.
    emitJson({ id: p.project_id, ...p, ...(git ? { git_connection_state: git } : {}) });
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
  process.stdout.write(`  ${C.dim}updated    ${C.reset}${formatRelative(p.updated_at)}\n`);
  if (git) process.stdout.write(gitConnectionLines(git));
  // Internal-only flags Kortix turned on. Agents read this to know which
  // Kortix-managed surfaces work here.
  const managed = featureRows(p as unknown as Record<string, unknown>)
    .filter((r) => r.operator_only && r.enabled)
    .map((r) => r.key);
  if (managed.length > 0) {
    process.stdout.write(`  ${C.dim}by kortix  ${C.reset}${managed.join(', ')}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function isDefaultProjectResponse(value: unknown): boolean {
  return value !== null && typeof value === 'object'
    && 'project_id' in value && typeof value.project_id === 'string' && value.project_id.trim().length > 0
    && 'account_id' in value && typeof value.account_id === 'string' && value.account_id.trim().length > 0
    && 'name' in value && typeof value.name === 'string' && value.name.trim().length > 0;
}

function invalidDefaultProjectResponse(value: unknown): number {
  const detail = value !== null && typeof value === 'object'
    && 'error' in value && typeof value.error === 'string' ? `: ${value.error}` : '';
  process.stderr.write(`${status.err(`Invalid workspace response${detail}. Expected project_id, account_id and name.`)}\n`);
  return 1;
}

/**
 * The caller's one workspace named `name` (case-insensitive), null when none
 * has it, or an exit code after printing why (several share it, or the list
 * failed).
 */
async function workspaceNamed(auth: Auth, name: string): Promise<ProjectSummary | null | number> {
  const report = await listWorkspaces(auth);
  if (typeof report === 'number') return report;
  const matches = report.rows.map((r) => r.project).filter((p) => p.name.toLowerCase() === name.toLowerCase());
  if (matches.length <= 1) return matches[0] ?? null;
  process.stderr.write(
    `${status.err(`${matches.length} workspaces are named "${name}".`)} Pass one id: ${matches.map((p) => p.project_id).join(', ')}\n`,
  );
  return 1;
}

async function projectsUse(arg?: string, hostArg?: string): Promise<number> {
  // --host names a logged-in host other than the active one: its credential
  // serves the request, and the default project binds on ITS host entry —
  // never the ambient session host (`activeHost()` prefers the sandbox env
  // token, which is what turned `use <id> --host <other>` into a 403 about
  // a project the user never referenced).
  const auth = hostArg ? loadAuthForHost(hostArg) : requireAuth();
  if (!auth?.token) {
    if (hostArg) {
      process.stderr.write(
        `${status.err(`Host "${hostArg}" is not logged in.`)} Run ${C.cyan}kortix login --host ${hostArg}${C.reset}.\n`,
      );
    }
    return 1;
  }

  let target: ProjectSummary | null = null;
  if (arg) {
    // An explicit id may live in any account — resolve it unscoped. A 404 on
    // the id tries it as a name: the one workspace of the caller with that
    // name (case-insensitive).
    try {
      target = await clientFromAuth(auth).get<ProjectSummary>(`/workspaces/${encodeURIComponent(arg)}`);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) return surface(err);
      const byName = await workspaceNamed(auth, arg);
      if (typeof byName === 'number') return byName;
      if (!byName) return surface(err);
      target = byName;
    }
  } else {
    // Pick from every workspace on the target host, flat.
    const report = await listWorkspaces(auth);
    if (typeof report === 'number') return report;
    // The picker offers the readable workspaces and names the unreadable.
    writeListFailures(report.failed);
    const rows = report.rows;
    const list = rows.map((r) => r.project);
    if (!list.every(isDefaultProjectResponse)) return invalidDefaultProjectResponse(list);
    if (list.length === 0) return noWorkspace();
    const currentId = (hostArg ? getHost(hostArg)?.default_project : defaultProject())?.project_id;
    const picked = await selectFromList<ProjectSummary>({
      title: 'Switch workspace',
      items: rows.map(({ project: p, account }) => ({
        value: p,
        label: p.project_id === currentId ? `${p.name}  ${C.green}●${C.reset}` : p.name,
        sublabel: account.role ? `${account.role} · ${p.project_id}` : p.project_id,
      })),
      initialIndex: Math.max(0, list.findIndex((p) => p.project_id === currentId)),
    });
    if (!picked) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
    target = picked;
  }

  if (!isDefaultProjectResponse(target)) return invalidDefaultProjectResponse(target);

  // A default project pins its account. If it lives in a different account
  // than the target host's active one, switch that host's active account to
  // it (resolving the account's display name best-effort) before recording
  // the default. With --host the comparison is against the named host's own
  // stored account, not the ambient active one.
  const priorAccountId = hostArg ? auth.account_id : (activeAccount()?.id ?? auth.account_id);
  const switched = target.account_id !== priorAccountId;
  if (switched) {
    let slug = target.account_id.slice(0, 8);
    let name: string | undefined;
    try {
      const me = await clientFromAuth(auth).get<MeResponse>('/me');
      const m = me.accounts.find((a) => a.account_id === target!.account_id);
      if (m) {
        slug = m.slug;
        name = m.name;
      }
    } catch {
      /* fall back to the truncated id */
    }
    setActiveAccount({ id: target.account_id, slug, name }, hostArg);
  }
  setDefaultProject(
    {
      project_id: target.project_id,
      account_id: target.account_id,
      name: target.name,
    },
    hostArg,
  );

  process.stdout.write(`${status.ok(`Default workspace: ${C.bold}${target.name}${C.reset}`)}\n`);
  if (hostArg) {
    process.stdout.write(`  ${C.dim}host      ${C.reset}${hostArg}\n`);
  }
  process.stdout.write(
    `  ${C.dim}Commands use it anywhere a directory is not linked.${C.reset}\n`,
  );
  return 0;
}

async function projectsUnset(hostArg?: string): Promise<number> {
  // The message describes the entry being cleared: the named host with
  // --host, else the active one (the same resolution clearDefaultProject uses).
  const existing = hostArg ? (getHost(hostArg)?.default_project ?? null) : defaultProject();
  if (clearDefaultProject(hostArg)) {
    process.stdout.write(
      `${status.ok(`Cleared the default workspace${existing?.name ? ` ${C.dim}(was ${existing.name})${C.reset}` : ''}`)}\n`,
    );
  } else {
    process.stdout.write(`${C.dim}No default workspace set. Nothing to do.${C.reset}\n`);
  }
  return 0;
}

async function projectsLink(arg?: string, hostArg?: string): Promise<number> {
  // --host names a logged-in host other than the active one: its stored
  // credential serves the request, like `projects use` — never the ambient
  // session token (the sandbox env token is scoped to the session's own
  // project, which turned `link <id> --host <other>` into a 403 about a
  // cross-project principal).
  const auth = hostArg ? loadAuthForHost(hostArg) : requireAuth();
  if (!auth?.token) {
    if (hostArg) {
      process.stderr.write(
        `${status.err(`Host "${hostArg}" is not logged in.`)} Run ${C.cyan}kortix login --host ${hostArg}${C.reset}.\n`,
      );
    }
    return 1;
  }

  // Refuse to scatter `.kortix/link.json` into random directories. A
  // project is only "Kortix-linkable" if it already has a `.kortix/`
  // dir (from `kortix init`) or a `kortix.yaml` at the root.
  if (!isKortixProject()) {
    process.stderr.write(
      `${status.err(`Not a Kortix config repo — no .kortix/ or kortix.yaml in ${process.cwd()}.`)}\n`,
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
      target = await client.get<ProjectSummary>(`/workspaces/${arg}`);
    } catch (err) {
      return surface(err);
    }
  } else {
    const report = await listWorkspaces(auth);
    if (typeof report === 'number') return report;
    // The picker offers the readable workspaces and names the unreadable.
    writeListFailures(report.failed);
    const rows = report.rows;
    const list = rows.map((r) => r.project);
    if (list.length === 0) return noWorkspace();
    const picked = await selectFromList<ProjectSummary>({
      title: `Pick a workspace to link to ${process.cwd()}`,
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
    process.stderr.write(`${status.err('Could not resolve a workspace.')}\n`);
    return 1;
  }

  // A --host link binds that host: the link record must name it so later
  // commands in this directory reach the project through its credential.
  const hostName = hostArg ?? activeHostName() ?? 'default';
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
  process.stdout.write(`  ${C.dim}workspace:  ${C.reset}${target.project_id}\n`);
  return 0;
}

async function projectsUnlink(): Promise<number> {
  const existing = loadLink();
  clearLink();
  if (existing) {
    process.stdout.write(
      `${status.ok(`Unlinked ${C.dim}(was ${existing.project_id})${C.reset}`)}\n`,
    );
  } else {
    process.stdout.write(`${C.dim}Not linked. Nothing to do.${C.reset}\n`);
  }
  return 0;
}

async function projectsOpen(arg?: string, hostArg?: string): Promise<number> {
  const id = resolveProjectId(arg, { hostScoped: !hostArg, hostArg });
  if (!id) {
    process.stderr.write(`${status.err('No workspace selected. Pass an id or link first.')}\n`);
    return 1;
  }
  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix workspaces open ${id} --host ${host}`,
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
  /** Set when the delete closed the workspace (K2): owners can restore it until then. */
  deletion_scheduled_for?: string | null;
}

async function projectsRm(args: string[]): Promise<number> {
  const rest = [...args];
  const yes = takeFlagBool(rest, ['-y', '--yes']);
  let hostArg: string | undefined;
  try {
    hostArg = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const id = rest.find((a) => !a.startsWith('-')) ?? resolveProjectId(undefined, { hostScoped: !hostArg, hostArg });
  if (!id) {
    process.stderr.write(
      `${status.err('No workspace to remove.')} Pass an id or run inside a linked directory.\n`,
    );
    return 1;
  }

  const located = await locateProjectAnywhere(
    id,
    { hostArg },
    (host) => `kortix workspaces rm ${id} --host ${host}`,
  );
  if (!located) return 1;
  const { client, project } = located.located;

  if (!yes) {
    const msg = `Delete ${C.bold}${project.name}${C.reset} for every member? Its owners can restore it for 14 days; after that its Kortix-managed git repo, sessions and credits are erased.`;
    const ok = await confirm(msg, false);
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }

  let result: RmResult;
  try {
    result = await client.delete<RmResult>(`/workspaces/${id}`);
  } catch (err) {
    return surface(err);
  }

  // Drop the local binding if we just removed the linked workspace.
  if (loadLink()?.project_id === id) clearLink();

  process.stdout.write(
    `${status.ok(`Deleted ${C.bold}${project.name}${C.reset}`)}\n` +
      (result.deletion_scheduled_for
        ? `  ${C.dim}an owner can restore it until ${result.deletion_scheduled_for} (POST /v1/workspaces/${id}/restore)${C.reset}\n`
        : result.repo_deleted
          ? `  ${C.dim}managed git repo deleted${C.reset}\n`
          : `  ${C.dim}no managed repo to delete (bring-your-own repos are left untouched)${C.reset}\n`),
  );
  return 0;
}

// ── helpers ────────────────────────────────────────────────────────────────

function surface(err: unknown): number {
  if (isNoWorkspaceError(err)) return noWorkspace();
  // A denial goes through the shared formatter so the CLI's tail names the
  // refused identity and the right remedy.
  if (err instanceof ApiError && err.status === 403) return surfaceApiError(err);
  if (err instanceof ApiError) {
    if (err.status === 401) {
      process.stderr.write(`${status.err(tokenRejectedLine(err.message))}\n`);
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
