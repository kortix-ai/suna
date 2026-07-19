import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

// The LLM-gateway control-plane for the linked project: how it ROUTES
// (default model / fallback / vision), METERS (spend budgets), EXPOSES itself
// (external gateway API keys), and is OBSERVED (usage / request logs) — plus a
// playground to test a model end to end. Deliberately its own command, not a
// `providers` subcommand: `providers` connects CREDENTIALS (a one-time input),
// while this configures ongoing gateway behavior. The split mirrors the API's
// own taxonomy — `/oauth` + `/secrets` (credentials) vs `/gateway/*` (this).
// Every handler wraps one `/projects/:id/gateway/*` route 1:1, so the CLI
// stays a thin, faithful client (see apps/api/src/projects/routes/gateway.ts).

const HELP = help`Usage: kortix gateway <subcommand> [options]

Configure and inspect the LLM gateway for the linked Kortix project — the
layer that routes every model request, meters spend, and exposes an
OpenAI-compatible endpoint. (Connect provider credentials with
\`kortix providers\`; pick per-agent models with \`kortix agents\`.)

Routing:
  routing [get]                     Show the effective default model, fallback
                                    chain, and vision fallback (+ where each
                                    resolves from). --json.
  routing set [flags]               Update the project routing policy:
    --default-model <id>              Default model ("" to clear).
    --vision-model <id>               Vision FALLBACK — only used on `auto` when
                                      an image is sent and the default model
                                      can't see images. Ignored otherwise.
    --fallback <id,id,…>              Fallback chain ("" to clear).
    --fallback-on transient|any-error
    --file <path|->                   Full policy JSON (stdin with -).
  routing reset                     Drop the project policy (fall back to
                                    account/platform defaults).
  routing preview <model> [--image] Resolve what a request would route to.

Spend:
  budget [ls]                       Budgets + this month's spend. --json.
  budget set --limit <usd> [flags]  Upsert a budget:
    --scope project|member  --user <id>  --period day|week|month
    --action block|warn
  budget rm <budgetId>              Remove a budget.

Access:
  keys [ls]                         External gateway API keys. --json.
  keys new <name>                   Mint a key (shown once).
  keys rm <keyId>                   Revoke a key.

Observability:
  usage [--days N]                  Request/error/cost totals + by-model. --json.
  logs [--limit N] [--failed]       Recent gateway requests. --json.
  logs <logId>                      One request's full detail (JSON).
  test <model…> [--prompt <text>]   Run a prompt through one or more models.

Global options:
  --project <id>     Operate on this project id (default: linked or \$KORTIX_PROJECT_ID).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output (read subcommands).
  -h, --help         Show this help.
`;

type CtxOpts = { projectArg?: string; hostArg?: string };

export async function runGateway(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  let json = false;
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  try {
    json = takeFlagBool(rest, ['--json']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'routing':
      return gatewayRouting(rest, ctxOpts, json);
    case 'budget':
    case 'budgets':
      return gatewayBudget(rest, ctxOpts, json);
    case 'keys':
    case 'key':
      return gatewayKeys(rest, ctxOpts, json);
    case 'usage':
    case 'overview':
      return gatewayUsage(rest, ctxOpts, json);
    case 'logs':
    case 'log':
      return gatewayLogs(rest, ctxOpts, json);
    case 'test':
    case 'playground':
      return gatewayTest(rest, ctxOpts, json);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

function money(n: unknown): string {
  const v = Number(n ?? 0);
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

// Emit JSON and return a success code — keeps the `if (json) return outJson(x)`
// call sites one line without the (biome-forbidden) comma operator.
function outJson(data: unknown): number {
  emitJson(data);
  return 0;
}

// Write a usage error and return the arg-error exit code (2).
function fail(message: string): number {
  process.stderr.write(`${status.err(message)}\n`);
  return 2;
}

// Pull an optional leading positional action (e.g. `routing set`) off argv,
// defaulting when the next token is a flag or absent. Avoids a non-null
// assertion on `rest.shift()`.
function takeAction(rest: string[], fallback: string): string {
  if (rest[0] && !rest[0].startsWith('-')) return rest.shift() as string;
  return fallback;
}

// ── Routing policy ──────────────────────────────────────────────────────────
// The default model / fallback chain / vision model the gateway applies for
// this project (GET/PUT/DELETE /gateway/routing-policy). Read shows the
// EFFECTIVE resolution (project → account → platform) so it's clear where each
// value comes from.

interface RoutingPolicyDoc {
  project: {
    defaultModel: string | null;
    visionModel: string | null;
    defaultFallback: { models: string[]; fallbackOn: string } | null;
    rules: { model: string; fallbackModels: string[]; fallbackOn: string }[];
  };
  effective: {
    defaultModel: string;
    defaultModelSource: string;
    visionModel: string;
    defaultFallback: { models: string[]; fallbackOn: string };
  };
  capabilities: { write: boolean };
}

export async function gatewayRouting(
  rest: string[],
  opts: CtxOpts,
  json: boolean,
): Promise<number> {
  const action = takeAction(rest, 'get');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}/gateway/routing-policy`;

  try {
    if (action === 'get' || action === 'show') {
      const doc = await ctx.client.get<RoutingPolicyDoc>(base);
      if (json) return outJson(doc);
      return renderRouting(doc);
    }
    if (action === 'reset') {
      const doc = await ctx.client.delete<RoutingPolicyDoc>(base);
      if (json) return outJson(doc);
      process.stdout.write(
        `\n  ${status.ok('routing policy reset to account/platform defaults')}\n\n`,
      );
      return renderRouting(doc);
    }
    if (action === 'preview') {
      const model = rest.find((a) => !a.startsWith('-'));
      if (!model) return fail('preview needs a model id');
      const image = rest.includes('--image');
      const res = await ctx.client.post<unknown>(`${base}/preview`, {
        requestedModel: model,
        imageInput: image,
      });
      if (json) return outJson(res);
      return outJson(res); // preview is inherently machine-shaped
    }
    if (action === 'set') {
      // Convenience flags for the common fields; --file/- for a full JSON body.
      let defaultModel: string | undefined;
      let visionModel: string | undefined;
      let fallback: string | undefined;
      let fallbackOn: string | undefined;
      let file: string | undefined;
      try {
        defaultModel = takeFlagValue(rest, ['--default-model', '--default']);
        visionModel = takeFlagValue(rest, ['--vision-model', '--vision']);
        fallback = takeFlagValue(rest, ['--fallback']);
        fallbackOn = takeFlagValue(rest, ['--fallback-on']);
        file = takeFlagValue(rest, ['--file']);
      } catch (err) {
        return fail((err as Error).message);
      }

      let body: Record<string, unknown>;
      if (file !== undefined) {
        const raw = file === '-' ? await readStdin() : await Bun.file(file).text();
        body = JSON.parse(raw) as Record<string, unknown>;
      } else {
        // Merge onto the current stored policy so a single field can be changed
        // without clobbering the rest.
        const current = await ctx.client.get<RoutingPolicyDoc>(base);
        body = {
          defaultModel: current.project.defaultModel,
          visionModel: current.project.visionModel,
          defaultFallback: current.project.defaultFallback,
          rules: current.project.rules,
        };
        if (defaultModel !== undefined) body.defaultModel = defaultModel || null;
        if (visionModel !== undefined) body.visionModel = visionModel || null;
        if (fallback !== undefined) {
          const models = fallback
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean);
          body.defaultFallback = models.length
            ? {
                models,
                fallbackOn:
                  fallbackOn ?? current.project.defaultFallback?.fallbackOn ?? 'transient',
              }
            : null;
        } else if (fallbackOn !== undefined && body.defaultFallback) {
          (body.defaultFallback as { fallbackOn: string }).fallbackOn = fallbackOn;
        }
      }

      const doc = await ctx.client.put<RoutingPolicyDoc>(base, body);
      if (json) return outJson(doc);
      process.stdout.write(`\n  ${status.ok('routing policy updated')}\n\n`);
      return renderRouting(doc);
    }
    process.stderr.write(
      `${status.err(`unknown routing action "${action}"`)} — get | set | reset | preview\n`,
    );
    return 2;
  } catch (err) {
    return surfaceApiError(err);
  }
}

function renderRouting(doc: RoutingPolicyDoc): number {
  const e = doc.effective;
  const fb = e.defaultFallback.models.length
    ? `${e.defaultFallback.models.join(' → ')} (${e.defaultFallback.fallbackOn})`
    : '—';
  process.stdout.write(
    `\n  ${C.dim}EFFECTIVE ROUTING${C.reset}\n` +
      `  default model   ${C.bold}${e.defaultModel}${C.reset} ${C.dim}(${e.defaultModelSource})${C.reset}\n` +
      `  vision fallback ${e.visionModel} ${C.dim}(auto only — used only when the default model can't see images)${C.reset}\n` +
      `  fallback        ${fb}\n`,
  );
  if (doc.project.rules.length) {
    process.stdout.write(`\n  ${C.dim}PER-MODEL RULES${C.reset}\n`);
    for (const r of doc.project.rules) {
      process.stdout.write(`  ${r.model} → ${r.fallbackModels.join(' → ')} (${r.fallbackOn})\n`);
    }
  }
  if (!doc.capabilities.write) {
    process.stdout.write(
      `\n  ${C.dim}(read-only — you lack customize-write on this project)${C.reset}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

// ── Budgets ─────────────────────────────────────────────────────────────────

export async function gatewayBudget(rest: string[], opts: CtxOpts, json: boolean): Promise<number> {
  const action = takeAction(rest, 'ls');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}/gateway/budgets`;

  try {
    if (action === 'ls' || action === 'list') {
      const data = await ctx.client.get<any>(base);
      if (json) return outJson(data);
      process.stdout.write(
        `\n  ${C.dim}PROJECT SPEND (this month)${C.reset}  ${money(data.project_spend?.cost)} · ${data.project_spend?.requests ?? 0} req\n`,
      );
      if (data.budgets?.length) {
        process.stdout.write(`\n  ${C.dim}BUDGETS${C.reset}\n`);
        for (const b of data.budgets) {
          const who = b.scope === 'member' ? ` ${C.dim}user=${b.subject_user_id}${C.reset}` : '';
          process.stdout.write(
            `  ${money(b.limit_usd)}/${b.period} ${b.scope} (${b.action})${who} ${C.faded}${b.budget_id}${C.reset}\n`,
          );
        }
      } else {
        process.stdout.write(`\n  ${C.dim}No budgets set.${C.reset}\n`);
      }
      process.stdout.write('\n');
      return 0;
    }
    if (action === 'set') {
      let scope: string | undefined;
      let user: string | undefined;
      let limit: string | undefined;
      let period: string | undefined;
      let actionFlag: string | undefined;
      try {
        scope = takeFlagValue(rest, ['--scope']);
        user = takeFlagValue(rest, ['--user']);
        limit = takeFlagValue(rest, ['--limit']);
        period = takeFlagValue(rest, ['--period']);
        actionFlag = takeFlagValue(rest, ['--action']);
      } catch (err) {
        return fail((err as Error).message);
      }
      if (!limit) return fail('--limit <usd> is required');
      const body: Record<string, unknown> = {
        scope: scope ?? (user ? 'member' : 'project'),
        limit_usd: Number(limit),
        ...(period ? { period } : {}),
        ...(actionFlag ? { action: actionFlag } : {}),
        ...(user ? { subject_user_id: user } : {}),
      };
      await ctx.client.put(base, body);
      process.stdout.write(
        `\n  ${status.ok(`budget set: ${money(limit)}/${body.period ?? 'month'} (${body.scope})`)}\n\n`,
      );
      return 0;
    }
    if (action === 'rm' || action === 'delete') {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) return fail('budget rm needs a budget id');
      await ctx.client.delete(`${base}/${encodeURIComponent(id)}`);
      process.stdout.write(`\n  ${status.ok(`budget ${id} removed`)}\n\n`);
      return 0;
    }
    process.stderr.write(`${status.err(`unknown budget action "${action}"`)} — ls | set | rm\n`);
    return 2;
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ── External gateway API keys ───────────────────────────────────────────────

export async function gatewayKeys(rest: string[], opts: CtxOpts, json: boolean): Promise<number> {
  const action = takeAction(rest, 'ls');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}/gateway/keys`;

  try {
    if (action === 'ls' || action === 'list') {
      const data = await ctx.client.get<any>(base);
      if (json) return outJson(data);
      process.stdout.write(`\n  ${C.dim}Gateway URL: ${data.gateway_url}${C.reset}\n\n`);
      if (!data.keys?.length) {
        process.stdout.write(
          `  ${C.dim}No gateway keys. Create one: kortix gateway keys new <name>${C.reset}\n\n`,
        );
        return 0;
      }
      const nameW = Math.max(...data.keys.map((k: any) => (k.name ?? '').length), 4);
      for (const k of data.keys) {
        const dot = k.status === 'active' ? `${C.green}●${C.reset}` : `${C.faded}○${C.reset}`;
        process.stdout.write(
          `  ${dot} ${pad(k.name ?? '', nameW)}  ${C.dim}${k.key_prefix}…  ${k.status}${C.reset}\n`,
        );
      }
      process.stdout.write('\n');
      return 0;
    }
    if (action === 'new' || action === 'create') {
      const name = rest.find((a) => !a.startsWith('-'));
      if (!name) return fail('keys new needs a name');
      const created = await ctx.client.post<any>(base, { name });
      if (json) return outJson(created);
      process.stdout.write(
        `\n  ${status.ok(`created gateway key "${name}"`)}\n\n` +
          `  ${C.bold}${created.secret_key}${C.reset}\n\n` +
          `  ${C.dim}Shown once — store it now. Use as the Bearer token against the gateway URL.${C.reset}\n\n`,
      );
      return 0;
    }
    if (action === 'rm' || action === 'revoke' || action === 'delete') {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) return fail('keys rm needs a key id');
      await ctx.client.delete(`${base}/${encodeURIComponent(id)}`);
      process.stdout.write(`\n  ${status.ok(`gateway key ${id} revoked`)}\n\n`);
      return 0;
    }
    process.stderr.write(`${status.err(`unknown keys action "${action}"`)} — ls | new | rm\n`);
    return 2;
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ── Usage / analytics ───────────────────────────────────────────────────────

export async function gatewayUsage(rest: string[], opts: CtxOpts, json: boolean): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  let days: string | undefined;
  try {
    days = takeFlagValue(rest, ['--days']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const q = days ? `?days=${encodeURIComponent(days)}` : '';
  try {
    const [overview, breakdown] = await Promise.all([
      ctx.client.get<any>(`/projects/${ctx.projectId}/gateway/overview${q}`),
      ctx.client.get<any>(`/projects/${ctx.projectId}/gateway/breakdown${q}`),
    ]);
    if (json) return outJson({ overview, breakdown });
    process.stdout.write(
      `\n  ${C.dim}LAST ${overview.window_days}d${C.reset}  ` +
        `${overview.requests} req · ${overview.errors} err · ${money(overview.total_cost)} · ` +
        `${overview.input_tokens}/${overview.output_tokens} tok\n`,
    );
    if (breakdown.models?.length) {
      process.stdout.write(`\n  ${C.dim}BY MODEL${C.reset}\n`);
      for (const m of breakdown.models) {
        process.stdout.write(
          `  ${pad(m.model, 28)} ${String(m.requests).padStart(5)} req  ${money(m.cost)}  ${C.dim}${m.provider}${C.reset}\n`,
        );
      }
    }
    process.stdout.write('\n');
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

export async function gatewayLogs(rest: string[], opts: CtxOpts, json: boolean): Promise<number> {
  // Pull flags off FIRST so a flag VALUE (e.g. the `3` in `--limit 3`) is never
  // mistaken for a positional logId.
  let limit: string | undefined;
  const failed = takeFlagBool(rest, ['--failed']);
  try {
    limit = takeFlagValue(rest, ['--limit']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  // `gateway logs <logId>` fetches one row's full request/response detail.
  const id = rest.find((a) => !a.startsWith('-'));
  try {
    if (id) {
      const row = await ctx.client.get<any>(
        `/projects/${ctx.projectId}/gateway/logs/${encodeURIComponent(id)}`,
      );
      return outJson(row);
    }
    const params = new URLSearchParams();
    if (limit) params.set('limit', limit);
    if (failed) params.set('ok', 'false');
    const qs = params.toString();
    const data = await ctx.client.get<any>(
      `/projects/${ctx.projectId}/gateway/logs${qs ? `?${qs}` : ''}`,
    );
    if (json) return outJson(data);
    if (!data.logs?.length) {
      process.stdout.write(`\n  ${C.dim}No gateway requests logged.${C.reset}\n\n`);
      return 0;
    }
    process.stdout.write('\n');
    for (const l of data.logs) {
      const dot = l.ok ? `${C.green}●${C.reset}` : `${C.red}●${C.reset}`;
      const err = l.ok
        ? ''
        : ` ${C.red}${l.error_code ?? ''}${C.reset} ${C.dim}${(l.error_message ?? '').slice(0, 80)}${C.reset}`;
      process.stdout.write(
        `  ${dot} ${pad(l.requested_model ?? '', 24)} ${String(l.status).padStart(3)} ${String(l.latency_ms ?? 0).padStart(5)}ms  ${C.faded}${l.request_id}${C.reset}${err}\n`,
      );
    }
    process.stdout.write('\n');
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ── Playground (test a model end-to-end through the gateway) ─────────────────

export async function gatewayTest(rest: string[], opts: CtxOpts, json: boolean): Promise<number> {
  let prompt: string | undefined;
  try {
    prompt = takeFlagValue(rest, ['--prompt', '-p']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const models = rest.filter((a) => !a.startsWith('-'));
  if (!models.length) return fail('pass at least one model id');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  try {
    const data = await ctx.client.post<any>(`/projects/${ctx.projectId}/gateway/playground`, {
      prompt: prompt ?? 'Reply with exactly: pong',
      models,
    });
    if (json) return outJson(data);
    process.stdout.write('\n');
    for (const r of data.results ?? []) {
      if (r.ok) {
        process.stdout.write(
          `  ${status.ok(r.model)} ${C.dim}${r.latency_ms}ms · ${r.input_tokens}/${r.output_tokens} tok${C.reset}\n` +
            `    ${String(r.output ?? '').slice(0, 200)}\n`,
        );
      } else {
        process.stdout.write(`  ${status.err(r.model)} ${C.dim}${r.error ?? 'failed'}${C.reset}\n`);
      }
    }
    process.stdout.write('\n');
    return (data.results ?? []).every((r: any) => r.ok) ? 0 : 1;
  } catch (err) {
    return surfaceApiError(err);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
