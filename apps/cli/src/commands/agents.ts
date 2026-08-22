import { readFileSync } from 'node:fs';

import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

// Mirrors GET /projects/:id/model-defaults (apps/api/src/projects/routes/r4.ts:3187).
interface ModelDefaults {
  platformDefault: string | null;
  accountDefault: string | null;
  projectDefault: string | null;
  agentDefaults: Record<string, string>;
  resolvedForCaller: string | null;
}

/** One entry of `GET /projects/:id/detail` → `config.agents`. */
interface DeclaredAgent {
  name: string;
  path: string;
  description: string | null;
  mode: string | null;
  enabled?: boolean;
  sandbox?: string | null;
  scope?: { env: string[] | 'all'; connectors: string[] | 'all'; kortix_cli: string[] | 'all' };
}

interface ProjectDetail {
  project_id: string;
  config: { agents?: DeclaredAgent[]; default_agent?: string | null };
}

/** `'all'` | `'none'` | an explicit list — AgentGrantSetV2 in the SDK. */
type GrantSet = 'all' | 'none' | string[];

/**
 * The full agent block on the wire — `AgentConfigBlock`
 * (the SDK agent-config module). `opencode`
 * is the behavior half, merged in from the agent's `.md` by the API.
 */
interface AgentConfigBlock {
  enabled?: boolean;
  sandbox?: string;
  connectors?: GrantSet;
  connectors_required?: string[];
  secrets?: GrantSet;
  skills?: GrantSet;
  kortix_cli?: GrantSet;
  workspace?: 'runtime' | 'read' | 'branch';
  opencode?: Record<string, unknown>;
}

interface AgentConfigResponse {
  agent: string;
  schema_version: number;
  editable?: boolean;
  default_agent: string | null;
  block: AgentConfigBlock | null;
}

/** PUT /projects/:id/agents/:name/scope response (agent-scope.ts:166). */
interface AgentScopeResponse {
  ok: boolean;
  agent: string;
  env: string[] | 'all';
  connectors: string[] | 'all';
  connectors_required: string[];
}

type ProjectCtx = NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>;

const HELP = help`Usage: kortix agents <subcommand> [options]

Per-agent settings on the linked Kortix project — the CLI half of Customize →
Agents. \`model\` pins an explicit concrete model (scope=agent); an agent with no
pin follows the project → account → platform default. Model pins and scope apply
instantly, with no kortix.yaml commit; \`default\` and \`config\` commit to
kortix.yaml on the project's default branch.

Subcommands:
  ls [--json]                     Show every agent's pinned model + the fallback
                                  default. (Alias: \`models\`.)
  model <agent> <model-id>        Pin an agent to a plain model id (e.g. glm-5.2).
  model <agent> --clear           Clear the pin — the agent follows the default again.
  default <agent>                 Make this the project's default agent.
  default --show [--json]         Print the current default agent.
  scope <agent> [options]         Which secrets/connectors the agent may use.
  scope <agent> --show [--json]   Print the agent's current scope.
  config <agent> [--json]         Print the full agent config block.
  config <agent> --file <path>    Replace the block with a JSON file's contents.
  config <agent> --set k=v ...    Change single (dotted) keys, merged in.

Scope options (all replace, none merge):
  --secrets all|none|A,B          Which project secrets reach the agent's env.
  --connectors all|none|a,b       Which connectors it may call as tools.
  --require-connector <slug>      Repeatable. Must resolve before a session starts.

Config options:
  --file <path>                   A JSON file holding the WHOLE block. \`-\` = stdin.
  --set <key>=<value>             Repeatable. Dotted path, e.g.
                                  \`opencode.model=glm-5.2\`, \`enabled=false\`,
                                  \`connectors=["slack"]\`. The value is parsed as
                                  JSON when it parses, else kept as a string.

Global:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

\`scope\` needs \`project.agent.write\`; \`default\` and \`config\` need
\`project.customize.write\`. Model pins live in the gateway, not in the repo —
the declarative one is kortix.yaml's \`[[agents]].model\`.
`;

export async function runAgents(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  let json = false;
  let clear = false;
  let show = false;
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let secretsFlag: string | undefined;
  let connectorsFlag: string | undefined;
  let requiredFlags: string[] = [];
  let fileFlag: string | undefined;
  let setFlags: string[] = [];
  try {
    json = takeFlagBool(rest, ['--json']);
    clear = takeFlagBool(rest, ['--clear', '--default', '--reset']);
    show = takeFlagBool(rest, ['--show']);
    requiredFlags = takeFlagValues(rest, ['--require-connector', '--required-connector']);
    setFlags = takeFlagValues(rest, ['--set']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    secretsFlag = takeFlagValue(rest, ['--secrets', '--env']);
    connectorsFlag = takeFlagValue(rest, ['--connectors']);
    fileFlag = takeFlagValue(rest, ['--file']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  const ctx = await resolveProjectContext({ projectArg: projectFlag, hostArg: hostFlag });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}/model-defaults`;

  try {
    switch (sub) {
      case 'models':
      case 'ls':
      case 'list': {
        const d = await ctx.client.get<ModelDefaults>(base);
        if (json) {
          emitJson(d);
          return 0;
        }
        const fallback =
          d.projectDefault ?? d.accountDefault ?? d.platformDefault ?? 'unavailable';
        const entries = Object.entries(d.agentDefaults ?? {});
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}Default (project → account → platform): ${C.reset}${C.bold}${fallback}${C.reset}\n\n`,
        );
        if (entries.length === 0) {
          process.stdout.write(
            `  ${C.dim}No per-agent model pins — every agent follows the default.${C.reset}\n` +
              `  ${C.dim}Pin one: ${C.reset}${C.cyan}kortix agents model <agent> <model-id>${C.reset}\n\n`,
          );
          return 0;
        }
        const w = Math.max(...entries.map(([n]) => n.length), 5);
        for (const [name, model] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
          process.stdout.write(`  ${pad(name, w)}   ${C.cyan}${model}${C.reset}\n`);
        }
        process.stdout.write(
          `\n  ${C.dim}${entries.length} pinned · the rest follow the default${C.reset}\n\n`,
        );
        return 0;
      }
      case 'model': {
        const agent = positional[0];
        if (!agent) return missing('an agent name');
        if (clear) {
          await ctx.client.delete(
            `${base}?scope=agent&agentName=${encodeURIComponent(agent)}`,
          );
          process.stdout.write(
            `${status.ok(`${C.bold}${agent}${C.reset} follows the default model again`)}\n`,
          );
          return 0;
        }
        const model = positional[1];
        if (!model) return missing('a plain model id (e.g. glm-5.2) — or --clear');
        await ctx.client.put(base, { scope: 'agent', agentName: agent, model });
        process.stdout.write(
          `${status.ok(`${C.bold}${agent}${C.reset} → ${C.cyan}${model}${C.reset}`)} ${C.dim}(applies to new sessions)${C.reset}\n`,
        );
        return 0;
      }
      case 'default':
        return await agentsDefault(ctx, positional[0], { show, json });
      case 'scope':
        return await agentsScope(ctx, positional[0], {
          secrets: secretsFlag,
          connectors: connectorsFlag,
          required: requiredFlags,
          show,
          json,
        });
      case 'config':
        return await agentsConfig(ctx, positional[0], { file: fileFlag, sets: setFlags, json });
      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ── default agent ───────────────────────────────────────────────────────────

async function agentsDefault(
  ctx: ProjectCtx,
  agent: string | undefined,
  opts: { show: boolean; json: boolean },
): Promise<number> {
  if (opts.show || !agent) {
    const detail = await ctx.client.get<ProjectDetail>(`/projects/${ctx.projectId}/detail`);
    const current = detail.config?.default_agent ?? null;
    if (opts.json) {
      emitJson({ default_agent: current, agents: (detail.config?.agents ?? []).map((a) => a.name) });
      return 0;
    }
    if (!agent && !opts.show) {
      // A bare `agents default` is ambiguous between "show me" and a typo.
      // Print the answer AND the setter so neither reading dead-ends.
      process.stdout.write(
        `  ${C.dim}default agent${C.reset}  ${current ? `${C.bold}${current}${C.reset}` : `${C.faded}none declared${C.reset}`}\n` +
          `  ${C.dim}Set one: ${C.reset}${C.cyan}kortix agents default <agent>${C.reset}\n`,
      );
      return 0;
    }
    process.stdout.write(
      `  ${C.dim}default agent${C.reset}  ${current ? `${C.bold}${current}${C.reset}` : `${C.faded}none declared${C.reset}`}\n`,
    );
    return 0;
  }

  const resp = await ctx.client.put<{ ok: boolean; default_agent: string }>(
    `/projects/${ctx.projectId}/default-agent`,
    { agent },
  );
  if (opts.json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Default agent → ${C.bold}${resp.default_agent}${C.reset}`)} ` +
      `${C.dim}(committed to kortix.yaml)${C.reset}\n`,
  );
  return 0;
}

// ── scope ───────────────────────────────────────────────────────────────────

/**
 * `PUT /agents/:name/scope` accepts only `'all'` or a list — there is no
 * `'none'` literal on that route (agent-scope.ts:44), so `none` is sent as the
 * empty list, which means the same thing.
 */
function parseGrantSet(raw: string): 'all' | string[] {
  const value = raw.trim();
  if (value === 'all' || value === '*') return 'all';
  if (value === 'none' || value === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderGrantSet(value: GrantSet | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (value === 'all') return 'all';
  if (value === 'none') return 'none';
  return value.length === 0 ? 'none' : value.join(', ');
}

async function agentsScope(
  ctx: ProjectCtx,
  agent: string | undefined,
  opts: {
    secrets?: string;
    connectors?: string;
    required: string[];
    show: boolean;
    json: boolean;
  },
): Promise<number> {
  if (!agent) return missing('an agent name');

  const wantsWrite =
    opts.secrets !== undefined || opts.connectors !== undefined || opts.required.length > 0;
  if (opts.show || !wantsWrite) {
    const cfg = await ctx.client.get<AgentConfigResponse>(
      `/projects/${ctx.projectId}/agents/${encodeURIComponent(agent)}/config`,
    );
    const block = cfg.block ?? {};
    if (opts.json) {
      emitJson({
        agent: cfg.agent,
        secrets: block.secrets ?? 'all',
        connectors: block.connectors ?? [],
        connectors_required: block.connectors_required ?? [],
        skills: block.skills ?? 'all',
        kortix_cli: block.kortix_cli ?? 'all',
      });
      return 0;
    }
    process.stdout.write(
      `\n  ${C.bold}${cfg.agent}${C.reset}\n` +
        `  ${C.dim}${pad('secrets', 20)}${C.reset} ${renderGrantSet(block.secrets, 'all (default)')}\n` +
        `  ${C.dim}${pad('connectors', 20)}${C.reset} ${renderGrantSet(block.connectors, 'none (default)')}\n` +
        `  ${C.dim}${pad('required connectors', 20)}${C.reset} ${block.connectors_required?.join(', ') || 'none'}\n` +
        `  ${C.dim}${pad('skills', 20)}${C.reset} ${renderGrantSet(block.skills, 'all (default)')}\n` +
        `  ${C.dim}${pad('kortix_cli', 20)}${C.reset} ${renderGrantSet(block.kortix_cli, 'all (default)')}\n\n`,
    );
    if (!opts.show) {
      process.stdout.write(
        `  ${C.dim}Change it: ${C.reset}${C.cyan}kortix agents scope ${agent} --connectors slack,github${C.reset}\n\n`,
      );
    }
    return 0;
  }

  // Each field the caller names is REPLACED; a field left out is untouched
  // (the route rejects a body with all three missing — guarded above).
  const body: Record<string, unknown> = {};
  if (opts.secrets !== undefined) body.env = parseGrantSet(opts.secrets);
  if (opts.connectors !== undefined) body.connectors = parseGrantSet(opts.connectors);
  if (opts.required.length > 0) {
    body.connectors_required = opts.required.flatMap((v) =>
      v.split(',').map((s) => s.trim()).filter(Boolean),
    );
  }

  const resp = await ctx.client.put<AgentScopeResponse>(
    `/projects/${ctx.projectId}/agents/${encodeURIComponent(agent)}/scope`,
    body,
  );
  if (opts.json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`${C.bold}${resp.agent}${C.reset} scope updated`)}\n` +
      `  ${C.dim}${pad('secrets', 20)}${C.reset} ${renderGrantSet(resp.env, 'all')}\n` +
      `  ${C.dim}${pad('connectors', 20)}${C.reset} ${renderGrantSet(resp.connectors, 'none')}\n` +
      `  ${C.dim}${pad('required connectors', 20)}${C.reset} ${resp.connectors_required.join(', ') || 'none'}\n`,
  );
  return 0;
}

// ── config ──────────────────────────────────────────────────────────────────

/** `a.b.c=value` → set `a.b.c`. The value is JSON when it parses, else a
 *  string, so `enabled=false` and `sandbox=node22` both do the obvious thing. */
function applySet(block: Record<string, unknown>, assignment: string): string | null {
  const eq = assignment.indexOf('=');
  if (eq <= 0) return `--set needs <key>=<value>, got "${assignment}"`;
  const path = assignment.slice(0, eq).split('.').filter(Boolean);
  const raw = assignment.slice(eq + 1);
  if (path.length === 0) return `--set needs a key, got "${assignment}"`;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  let cursor = block;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (next === undefined || next === null) cursor[key] = {};
    else if (typeof next !== 'object' || Array.isArray(next)) {
      return `Cannot set "${assignment}": "${key}" is not an object`;
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]!] = value;
  return null;
}

async function agentsConfig(
  ctx: ProjectCtx,
  agent: string | undefined,
  opts: { file?: string; sets: string[]; json: boolean },
): Promise<number> {
  if (!agent) return missing('an agent name');
  const path = `/projects/${ctx.projectId}/agents/${encodeURIComponent(agent)}/config`;

  if (!opts.file && opts.sets.length === 0) {
    const cfg = await ctx.client.get<AgentConfigResponse>(path);
    if (opts.json) {
      emitJson(cfg);
      return 0;
    }
    if (!cfg.editable) {
      process.stdout.write(
        `  ${C.yellow}!${C.reset}  ${C.dim}kortix_version ${cfg.schema_version} manifest — this block is read-only. Upgrade to kortix.yaml v2 to edit it.${C.reset}\n`,
      );
    }
    process.stdout.write(`${JSON.stringify(cfg.block ?? {}, null, 2)}\n`);
    return 0;
  }

  let block: AgentConfigBlock;
  if (opts.file) {
    const raw = opts.file === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.file, 'utf-8');
    try {
      block = JSON.parse(raw) as AgentConfigBlock;
    } catch (err) {
      process.stderr.write(`${status.err(`Not valid JSON: ${(err as Error).message}`)}\n`);
      return 2;
    }
  } else {
    // The PUT REPLACES the agent's whole kortix.yaml entry (agent-config-v2.ts:174)
    // and deletes every known `.md` frontmatter key the body omits
    // (mergeFrontmatter, agent-config.ts:128). So --set has to read the current
    // block first and send it back whole, or it silently wipes everything else.
    const current = await ctx.client.get<AgentConfigResponse>(path);
    block = (current.block ?? {}) as AgentConfigBlock;
  }

  for (const assignment of opts.sets) {
    const err = applySet(block as Record<string, unknown>, assignment);
    if (err) {
      process.stderr.write(`${status.err(err)}\n`);
      return 2;
    }
  }

  const resp = await ctx.client.put<{ ok: boolean; agent: string; block: AgentConfigBlock }>(
    path,
    block,
  );
  if (opts.json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`${C.bold}${resp.agent}${C.reset} config saved`)} ${C.dim}(committed to kortix.yaml${block.opencode ? ' + the agent .md' : ''})${C.reset}\n`,
  );
  return 0;
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}
