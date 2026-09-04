/**
 * `kortix models <subcommand>` — which models this project OFFERS, and which
 * one it starts sessions with. The CLI half of Customize → Models.
 *
 * Two independent server-owned things live here, and they must not be confused:
 *
 *  1. ENABLEMENT (`ls` / `enable` / `disable` / `reset`) — display only. The
 *     project stores EXCEPTIONS to the catalog default (newest model per
 *     family), not the resolved set; `PUT /model-enablement` replaces the WHOLE
 *     exception map, so every write here reads the current map first and merges
 *     into it. The gateway still serves a disabled model if a caller names it
 *     outright (apps/api/src/projects/routes/r4.ts:3070).
 *  2. DEFAULTS (`default`) — what `auto` resolves to, at project or account
 *     scope. The per-AGENT pin stays on `kortix agents model <agent> <id>`.
 *
 * Both writes assert `project.customize.write`.
 */

import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

/** One entry of GET /projects/:id/model-picker `models` (GatewayCatalogModel). */
interface PickerModel {
  name?: string;
  provider?: string;
  enabled?: boolean;
  free?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
}

/** GET /projects/:id/model-picker (r4.ts:2983). */
interface ModelPicker {
  models: Record<string, PickerModel>;
  modelOverrides?: Record<string, boolean>;
  usingDefaults?: boolean;
  defaultModel?: string;
}

/** GET /projects/:id/model-defaults (r4.ts:3187). */
interface ModelDefaults {
  platformDefault: string | null;
  accountDefault: string | null;
  agentDefaults: Record<string, string>;
  projectDefault: string | null;
  resolvedForCaller: string | null;
  resolvedSource?: string;
  freeTier?: boolean;
}

const HELP = help`Usage: kortix models <subcommand> [options]

Which models this project offers, and which one it starts with. Same surface as
the dashboard's Customize → Models.

A project stores only its EXCEPTIONS to the catalog default (the newest model of
each family). \`enable\`/\`disable\` merge into that stored map; \`reset\` empties it.
Enablement is display-only — it decides what pickers OFFER, never what the
gateway serves.

Subcommands:
  ls [--json]                     List every model: state, origin, provider.
  enable <model-id>...            Offer these models.
  disable <model-id>...           Stop offering them. The project default
                                  refuses with 409 — change the default first.
  reset                           Drop every exception; back to catalog default.
  default [--json]                Print the default chain (project → account →
                                  platform) and what it resolves to.
  default <model-id> [--account]  Set the project default (or the account-wide
                                  one with --account).
  default --clear [--account]     Clear the project (or account) default.

Model ids are gateway wire ids — a bare managed id (\`glm-5.3-flash\`) or a BYOK
\`provider/model\`. Copy one from \`kortix models ls --json\`.

Per-agent pins live on \`kortix agents model <agent> <model-id>\`.

Options:
  --account          default: act on the ACCOUNT scope, not this project.
  --clear            default: remove the pin instead of setting one.
  --json             Machine-readable output (ls, default).
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.

Writes need the \`project.customize.write\` permission.
`;

export async function runModels(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // The root help promises `kortix <cmd> <subcommand> --help`. None of the
  // subcommands below own dedicated help text, so without this a bare
  // `--help` falls through as an ordinary positional arg and the command
  // runs (or fails on auth) instead of printing usage.
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  let json = false;
  let account = false;
  let clear = false;
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  try {
    json = takeFlagBool(rest, ['--json']);
    account = takeFlagBool(rest, ['--account']);
    clear = takeFlagBool(rest, ['--clear', '--unset']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  const ctx = await resolveProjectContext({ projectArg: projectFlag, hostArg: hostFlag });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}`;

  try {
    switch (sub) {
      case 'ls':
      case 'list':
        return await modelsLs(ctx.client, base, json);
      case 'enable':
      case 'disable':
        return await modelsToggle(ctx.client, base, positional, sub === 'enable', json);
      case 'reset':
        return await modelsReset(ctx.client, base, json);
      case 'default':
      case 'defaults':
        return await modelsDefault(ctx.client, base, positional[0], { account, clear, json });
      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

type Client = NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>['client'];

async function modelsLs(client: Client, base: string, json: boolean): Promise<number> {
  const picker = await client.get<ModelPicker>(`${base}/model-picker`);
  if (json) {
    emitJson(picker);
    return 0;
  }
  const overrides = picker.modelOverrides ?? {};
  const rows = Object.entries(picker.models ?? {}).sort(([aId, a], [bId, b]) => {
    const p = (a.provider ?? '').localeCompare(b.provider ?? '');
    return p !== 0 ? p : aId.localeCompare(bId);
  });
  if (rows.length === 0) {
    process.stdout.write(`  ${C.dim}No models served for this project.${C.reset}\n`);
    return 0;
  }
  const idW = Math.min(44, Math.max(...rows.map(([id]) => id.length), 5));
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('MODEL', idW)}   STATE   ORIGIN     PROVIDER${C.reset}\n`,
  );
  let enabledCount = 0;
  for (const [id, model] of rows) {
    const on = model.enabled !== false;
    if (on) enabledCount += 1;
    const isDefault = id === picker.defaultModel;
    const marker = isDefault ? `${C.green}●${C.reset} ` : '  ';
    const state = on ? `${C.green}${pad('on', 6)}${C.reset}` : `${C.faded}${pad('off', 6)}${C.reset}`;
    const origin = id in overrides ? 'override' : 'default';
    process.stdout.write(
      `${marker}${pad(trim(id, idW), idW)}   ${state}  ${pad(origin, 9)}  ${C.faded}${model.provider ?? '—'}${C.reset}\n`,
    );
  }
  const exceptions = Object.keys(overrides).length;
  process.stdout.write(
    `\n  ${C.dim}${enabledCount}/${rows.length} offered · ` +
      `${exceptions === 0 ? 'no exceptions (catalog default)' : `${exceptions} exception${exceptions === 1 ? '' : 's'}`} · ` +
      `${C.reset}${C.green}●${C.reset}${C.dim} = project default (${picker.defaultModel ?? '—'})${C.reset}\n\n`,
  );
  return 0;
}

/**
 * `PUT /model-enablement` REPLACES the stored exception map — a bare
 * `{ id: false }` would silently drop every other exception the project made.
 * So read the current map off /model-picker, merge, then PUT.
 */
async function modelsToggle(
  client: Client,
  base: string,
  ids: string[],
  enabled: boolean,
  json: boolean,
): Promise<number> {
  const verb = enabled ? 'enable' : 'disable';
  if (ids.length === 0) return missing(`at least one model id to ${verb}`);

  const picker = await client.get<ModelPicker>(`${base}/model-picker`);
  const known = new Set(Object.keys(picker.models ?? {}));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    process.stderr.write(
      `${status.err(`Not served by this project: ${unknown.join(', ')}`)} ` +
        `List the ids with ${C.cyan}kortix models ls${C.reset}.\n`,
    );
    return 1;
  }
  const next: Record<string, boolean> = { ...(picker.modelOverrides ?? {}) };
  for (const id of ids) next[id] = enabled;

  const resp = await client.put<{ ok: boolean; modelOverrides: Record<string, boolean> }>(
    `${base}/model-enablement`,
    { modelOverrides: next },
  );
  if (json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`${ids.length} model${ids.length === 1 ? '' : 's'} ${enabled ? 'offered' : 'hidden'}: ${C.bold}${ids.join(', ')}${C.reset}`)}\n`,
  );
  return 0;
}

async function modelsReset(client: Client, base: string, json: boolean): Promise<number> {
  const resp = await client.put<{ ok: boolean; modelOverrides: Record<string, boolean> }>(
    `${base}/model-enablement`,
    { modelOverrides: {} },
  );
  if (json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok('Every exception dropped')} ${C.dim}— the project offers the catalog default again.${C.reset}\n`,
  );
  return 0;
}

async function modelsDefault(
  client: Client,
  base: string,
  model: string | undefined,
  opts: { account: boolean; clear: boolean; json: boolean },
): Promise<number> {
  const path = `${base}/model-defaults`;
  const scope = opts.account ? 'account' : 'project';

  if (opts.clear) {
    const resp = await client.delete<{ ok: boolean }>(`${path}?scope=${scope}`);
    if (opts.json) {
      emitJson(resp);
      return 0;
    }
    process.stdout.write(`${status.ok(`Cleared the ${scope} default model`)}\n`);
    return 0;
  }

  if (!model) {
    const d = await client.get<ModelDefaults>(path);
    if (opts.json) {
      emitJson(d);
      return 0;
    }
    process.stdout.write('\n');
    row('project', d.projectDefault);
    row('account', d.accountDefault);
    row('platform', d.platformDefault);
    process.stdout.write(
      `\n  ${C.dim}resolves to ${C.reset}${C.bold}${d.resolvedForCaller ?? '—'}${C.reset}` +
        `${d.resolvedSource ? ` ${C.dim}(${d.resolvedSource})${C.reset}` : ''}\n`,
    );
    const pins = Object.keys(d.agentDefaults ?? {}).length;
    if (pins > 0) {
      process.stdout.write(
        `  ${C.dim}${pins} per-agent pin${pins === 1 ? '' : 's'} — see ${C.reset}${C.cyan}kortix agents models${C.reset}\n`,
      );
    }
    process.stdout.write('\n');
    return 0;
  }

  const resp = await client.put<{ ok: boolean; scope: string; model: string }>(path, {
    scope,
    model,
  });
  if (opts.json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`${scope} default → ${C.cyan}${model}${C.reset}`)} ${C.dim}(applies to new sessions)${C.reset}\n`,
  );
  return 0;
}

function row(label: string, value: string | null): void {
  process.stdout.write(
    `  ${C.dim}${pad(label, 9)}${C.reset} ${value ? `${C.cyan}${value}${C.reset}` : `${C.faded}unset${C.reset}`}\n`,
  );
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
