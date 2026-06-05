import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
  takeFlagBool,
} from '../command-helpers.ts';
import { promptSecret } from '../prompts.ts';
import {
  appendArrayBlock,
  arrayEntryExists,
  removeArrayBlock,
  setTableScalar,
} from '../manifest-edit.ts';
import { C, pad, status } from '../style.ts';

// ── Shapes (mirror apps/api/src/executor) ───────────────────────────────────

type Provider = 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http';

interface ConnectorAction {
  path: string;
  name: string;
  description: string;
  risk: string;
  inputSchema: Record<string, unknown> | null;
}

interface AdminConnector {
  slug: string;
  name: string;
  provider: Provider;
  status: 'active' | 'disabled' | 'needs_auth' | 'error';
  credentialMode: 'shared' | 'per_user';
  actions: ConnectorAction[];
  authSecret: string | null;
  sharing: ConnectorSharing | null;
  secretSet: boolean;
}

type ConnectorSharing =
  | { mode: 'project' }
  | { mode: 'private'; ownerId?: string }
  | { mode: 'members'; memberIds?: string[]; groupIds?: string[] };

interface SyncResult {
  synced: number;
  errors: Array<{ slug: string; error: string }>;
}

const PROVIDERS: readonly Provider[] = ['pipedream', 'mcp', 'openapi', 'graphql', 'http'];

const HELP = `Usage: kortix connectors <subcommand> [options]

Manage the project's connectors — the integrations agents call as tools
(Pipedream apps, MCP servers, OpenAPI/GraphQL/HTTP endpoints). Mirrors the
dashboard's Customize → Connectors.

Config lives in kortix.toml (the source of truth): \`add\`/\`rm\`/\`policy set\`
edit your LOCAL file — run \`kortix ship\` to apply, then \`sync\` to reconcile.
Only credentials, OAuth, sharing and reads talk to the cloud.

Subcommands:
  ls                                List connectors + status, auth, sharing.
  show <slug>                       Show one connector's tools (actions).
  add <slug> --provider <p> [...]   Add a [[connectors]] block to kortix.toml.
  rm <slug>                         Remove a [[connectors]] block from kortix.toml.
  rename <slug> <name…>             Set a connector's display name (applies now).
  mode <slug> <shared|per_user>     Set the profile model (applies now + re-syncs).
  sync                              Reconcile the catalog from the shipped kortix.toml.
  credential <slug> [value]         Set a connector's credential (prompts if
                                    no value; reads stdin with \`-\`).
  share <slug> --mode <m> [...]     Set who can use it (project|private|members).
  connect <slug>                    Start a Pipedream 1-click connect.
  finalize <slug>                   Confirm a Pipedream connection completed.
  apps [<query>]                    Browse the Pipedream app catalog.
  policy ls                         Show project-wide execution policies.
  policy set --default <risk|allow_all>   Set the default execution mode.
  policy <slug> ls                  Show one connector's tool-call rules.
  policy <slug> set <match> <act>   Allow|ask|block a tool/glob/regex (applies now).
                                    <match> = tool name, glob (send_*) or /regex/.
  policy <slug> rm <match>          Remove a connector rule.
  policy <slug> clear               Remove all of a connector's rules.

Add options (provider-specific):
  --name <label>           Human label (default: slug).
  --provider <p>           ${PROVIDERS.join('|')}.
  --app <slug>             Pipedream app slug (provider=pipedream).
  --url <url>              MCP server URL (provider=mcp).
  --transport <http|sse>   MCP transport (provider=mcp).
  --endpoint <url>         GraphQL endpoint (provider=graphql).
  --base-url <url>         HTTP base URL (provider=http).
  --spec <url|path>        OpenAPI/GraphQL/HTTP spec ref.
  --auth-type <t>          none|bearer|basic|custom.
  --credential <mode>      shared|per_user.

Share options:
  --mode <m>               project | private | members.
  --members <id,id>        member ids (mode=members).
  --groups <id,id>         group ids (mode=members).

Global:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

export async function runConnectors(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  let f: Record<string, string | undefined> = {};
  let asStdin = false;
  try {
    f.project = takeFlagValue(rest, ['--project']);
    f.host = takeFlagValue(rest, ['--host']);
    f.name = takeFlagValue(rest, ['--name']);
    f.provider = takeFlagValue(rest, ['--provider']);
    f.app = takeFlagValue(rest, ['--app']);
    f.url = takeFlagValue(rest, ['--url']);
    f.transport = takeFlagValue(rest, ['--transport']);
    f.endpoint = takeFlagValue(rest, ['--endpoint']);
    f.baseUrl = takeFlagValue(rest, ['--base-url']);
    f.spec = takeFlagValue(rest, ['--spec']);
    f.authType = takeFlagValue(rest, ['--auth-type']);
    f.credential = takeFlagValue(rest, ['--credential']);
    f.mode = takeFlagValue(rest, ['--mode']);
    f.members = takeFlagValue(rest, ['--members']);
    f.groups = takeFlagValue(rest, ['--groups']);
    f.cursor = takeFlagValue(rest, ['--cursor']);
    f.default = takeFlagValue(rest, ['--default']);
    asStdin = takeFlagBool(rest, ['--stdin']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  // ── Config mutations edit the LOCAL kortix.toml (the source of truth). No
  //    cloud call, no auth — you `kortix ship` to apply. Only credentials,
  //    OAuth, sharing, reconcile + reads talk to the cloud. ───────────────────
  if (sub === 'add' || sub === 'create') return connectorAddLocal(positional[0], f);
  if (sub === 'rm' || sub === 'remove' || sub === 'delete') return connectorRmLocal(positional[0]);
  if ((sub === 'policy' || sub === 'policies') && positional[0] === 'set') return policySetLocal(f.default);

  const ctx = resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;
  const ex = `/executor/projects/${ctx.projectId}`;

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const { connectors } = await ctx.client.get<{ connectors: AdminConnector[] }>(`${ex}/connectors`);
        if (connectors.length === 0) {
          process.stdout.write(
            `  ${C.dim}No connectors. Add one: ${C.reset}${C.cyan}kortix connectors add <slug> --provider mcp --url …${C.reset}\n`,
          );
          return 0;
        }
        const slugW = Math.max(...connectors.map((c) => c.slug.length), 4);
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}${pad('SLUG', slugW)}   STATUS       PROVIDER     CRED        TOOLS  SHARING${C.reset}\n`,
        );
        for (const c of connectors) {
          process.stdout.write(
            `  ${pad(c.slug, slugW)}   ${statusCell(c.status)}  ${pad(c.provider, 11)}  ${pad(c.credentialMode, 9)}  ${pad(String(c.actions.length), 5)}  ${C.faded}${sharingLabel(c.sharing)}${C.reset}\n`,
          );
        }
        process.stdout.write(`\n  ${C.dim}${connectors.length} connector${connectors.length === 1 ? '' : 's'}${C.reset}\n\n`);
        return 0;
      }
      case 'show': {
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        const { connectors } = await ctx.client.get<{ connectors: AdminConnector[] }>(`${ex}/connectors`);
        const c = connectors.find((x) => x.slug === slug);
        if (!c) {
          process.stderr.write(`${status.err(`No connector "${slug}".`)}\n`);
          return 1;
        }
        process.stdout.write(`\n  ${C.bold}${c.name}${C.reset} ${C.faded}(${c.slug})${C.reset}\n`);
        process.stdout.write(`  ${C.dim}provider ${C.reset}${c.provider}   ${C.dim}status ${C.reset}${statusCell(c.status)}   ${C.dim}cred ${C.reset}${c.credentialMode}${c.secretSet ? ` ${C.green}(set)${C.reset}` : ''}\n`);
        process.stdout.write(`  ${C.dim}sharing ${C.reset}${sharingLabel(c.sharing)}\n\n`);
        if (c.actions.length === 0) {
          process.stdout.write(`  ${C.dim}No tools materialized yet — run \`kortix connectors sync\`.${C.reset}\n\n`);
          return 0;
        }
        for (const a of c.actions) {
          process.stdout.write(`  ${C.cyan}${a.path}${C.reset} ${C.faded}[${a.risk}]${C.reset}\n`);
          if (a.description) process.stdout.write(`    ${C.dim}${trim(a.description, 80)}${C.reset}\n`);
        }
        process.stdout.write(`\n  ${C.dim}${c.actions.length} tool${c.actions.length === 1 ? '' : 's'}${C.reset}\n\n`);
        return 0;
      }
      case 'sync': {
        const resp = await ctx.client.post<SyncResult>(`${ex}/connectors/sync`);
        process.stdout.write(`${status.ok(`Synced ${resp.synced} connector${resp.synced === 1 ? '' : 's'}`)}\n`);
        reportSync(resp);
        return 0;
      }
      case 'credential':
      case 'cred': {
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        // A bare `-` reads the value from stdin. It starts with '-', so it's
        // not in `positional` — detect it on the raw arg list.
        const wantStdin = asStdin || rest.includes('-');
        let value = positional[1];
        if (wantStdin) {
          value = (await readStdin()).replace(/\n$/, '');
        } else if (!value) {
          value = await promptSecret(`  value for ${C.bold}${slug}${C.reset}`);
        }
        if (!value) {
          process.stderr.write(`${status.err('No value provided.')}\n`);
          return 2;
        }
        await ctx.client.put(`${ex}/connectors/${encodeURIComponent(slug)}/credential`, { value });
        process.stdout.write(`${status.ok(`Credential set for ${C.bold}${slug}${C.reset}`)}\n`);
        return 0;
      }
      case 'share':
      case 'sharing': {
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        const mode = f.mode;
        if (mode !== 'project' && mode !== 'private' && mode !== 'members') {
          return missing('--mode project|private|members');
        }
        let sharing: ConnectorSharing;
        if (mode === 'members') {
          sharing = {
            mode,
            memberIds: splitCsv(f.members),
            groupIds: splitCsv(f.groups),
          };
        } else {
          sharing = { mode };
        }
        await ctx.client.put(`${ex}/connectors/${encodeURIComponent(slug)}/sharing`, sharing);
        process.stdout.write(`${status.ok(`Sharing for ${C.bold}${slug}${C.reset} → ${mode}`)}\n`);
        return 0;
      }
      case 'connect': {
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        const resp = await ctx.client.post<{ token: string; app: string; connectUrl?: string }>(
          `${ex}/connectors/${encodeURIComponent(slug)}/connect`,
        );
        process.stdout.write(`\n  ${C.bold}Connect ${slug}${C.reset} ${C.faded}(${resp.app})${C.reset}\n`);
        if (resp.connectUrl) {
          process.stdout.write(`  ${C.dim}Open this URL to authorize:${C.reset}\n  ${C.cyan}${resp.connectUrl}${C.reset}\n`);
        } else {
          process.stdout.write(
            `  ${C.dim}1-click token minted. Complete the connect in the dashboard, or via the${C.reset}\n` +
              `  ${C.dim}Pipedream SDK with this token:${C.reset}\n  ${C.faded}${resp.token}${C.reset}\n`,
          );
        }
        process.stdout.write(
          `\n  ${C.dim}When done, run ${C.reset}${C.cyan}kortix connectors finalize ${slug}${C.reset}${C.dim} to confirm.${C.reset}\n\n`,
        );
        return 0;
      }
      case 'finalize': {
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        const resp = await ctx.client.post<{ connected: boolean; accountId?: string }>(
          `${ex}/connectors/${encodeURIComponent(slug)}/connect/finalize`,
        );
        if (resp.connected) {
          process.stdout.write(`${status.ok(`${C.bold}${slug}${C.reset} connected${resp.accountId ? ` ${C.faded}(${resp.accountId})${C.reset}` : ''}`)}\n`);
          return 0;
        }
        process.stdout.write(`  ${status.warn(`${slug} not connected yet — finish the authorize step, then retry.`)}\n`);
        return 1;
      }
      case 'rename':
      case 'name': {
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        const name = positional.slice(1).join(' ').trim() || f.name;
        if (!name) return missing('a new name');
        await ctx.client.put(`${ex}/connectors/${encodeURIComponent(slug)}/name`, { name });
        process.stdout.write(`${status.ok(`Renamed ${C.bold}${slug}${C.reset} → ${name}`)}\n`);
        return 0;
      }
      case 'mode': {
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        const mode = positional[1] ?? f.credential;
        if (mode !== 'shared' && mode !== 'per_user') return missing('<shared|per_user>');
        await ctx.client.put(`${ex}/connectors/${encodeURIComponent(slug)}/credential-mode`, { mode });
        process.stdout.write(`${status.ok(`Profile model for ${C.bold}${slug}${C.reset} → ${mode}`)}\n`);
        return 0;
      }
      case 'apps': {
        const q = positional[0];
        const qs = [q ? `q=${encodeURIComponent(q)}` : '', f.cursor ? `cursor=${encodeURIComponent(f.cursor)}` : '']
          .filter(Boolean)
          .join('&');
        const resp = await ctx.client.get<{
          apps: { slug: string; name: string; description: string | null; categories: string[] }[];
          nextCursor?: string;
          hasMore: boolean;
        }>(`${ex}/pipedream/apps${qs ? `?${qs}` : ''}`);
        if (resp.apps.length === 0) {
          process.stdout.write(`  ${C.dim}No apps${q ? ` matching "${q}"` : ''}.${C.reset}\n`);
          return 0;
        }
        const slugW = Math.max(...resp.apps.map((a) => a.slug.length), 4);
        process.stdout.write('\n');
        for (const a of resp.apps) {
          process.stdout.write(`  ${C.cyan}${pad(a.slug, slugW)}${C.reset}  ${trim(a.name, 30)}  ${C.dim}${trim(a.description ?? '', 40)}${C.reset}\n`);
        }
        process.stdout.write(
          `\n  ${C.dim}${resp.apps.length} app${resp.apps.length === 1 ? '' : 's'}${resp.hasMore ? ` · more: --cursor ${resp.nextCursor}` : ''}${C.reset}\n\n`,
        );
        return 0;
      }
      case 'policy':
      case 'policies': {
        const a0 = positional[0] ?? 'ls';
        // Project-wide: `policy ls`. (`policy set --default` is handled earlier.)
        if (a0 === 'ls' || a0 === 'list') {
          const resp = await ctx.client.get<{
            policies: { match: string; action: string }[];
            defaultMode: string;
          }>(`${ex}/policies`);
          process.stdout.write(`\n  ${C.dim}default mode: ${C.reset}${C.bold}${resp.defaultMode}${C.reset}\n`);
          if (resp.policies.length === 0) {
            process.stdout.write(`  ${C.dim}No explicit project policies.${C.reset}\n\n`);
            return 0;
          }
          for (const p of resp.policies) process.stdout.write(`  ${C.cyan}${p.match}${C.reset} → ${p.action}\n`);
          process.stdout.write('\n');
          return 0;
        }

        // Connector-scoped: `policy <slug> <ls|set|rm|clear> …`
        const slug = a0;
        const cAction = positional[1] ?? 'ls';
        const path = `${ex}/connectors/${encodeURIComponent(slug)}/policies`;
        const load = () => ctx.client.get<{ policies: { match: string; action: string }[] }>(path);

        if (cAction === 'ls' || cAction === 'list') {
          const { policies } = await load();
          if (policies.length === 0) {
            process.stdout.write(`  ${C.dim}No rules for ${slug} — every tool follows global rules & risk.${C.reset}\n`);
            return 0;
          }
          process.stdout.write('\n');
          for (const p of policies) process.stdout.write(`  ${C.cyan}${p.match}${C.reset} → ${p.action}\n`);
          process.stdout.write('\n');
          return 0;
        }
        if (cAction === 'set') {
          const match = positional[2];
          const action = normalizePolicyAction(positional[3]);
          if (!match) return missing('a <match> (tool name, glob, or /regex/)');
          if (!action) return missing('an action: allow | ask | block');
          const { policies } = await load();
          const next = [...policies.filter((p) => p.match !== match), { match, action }];
          await ctx.client.put(path, { policies: next });
          process.stdout.write(`${status.ok(`${C.bold}${slug}${C.reset}: ${match} → ${action}`)}\n`);
          return 0;
        }
        if (cAction === 'rm' || cAction === 'remove') {
          const match = positional[2];
          if (!match) return missing('the <match> to remove');
          const { policies } = await load();
          await ctx.client.put(path, { policies: policies.filter((p) => p.match !== match) });
          process.stdout.write(`${status.ok(`${C.bold}${slug}${C.reset}: removed ${match}`)}\n`);
          return 0;
        }
        if (cAction === 'clear') {
          await ctx.client.put(path, { policies: [] });
          process.stdout.write(`${status.ok(`${C.bold}${slug}${C.reset}: cleared all rules`)}\n`);
          return 0;
        }
        process.stderr.write(`${status.err(`unknown policy action "${cAction}"`)}\n`);
        return 2;
      }
      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ── Local kortix.toml config edits (source of truth; no cloud round-trip) ────

function connectorAddLocal(slug: string | undefined, f: Record<string, string | undefined>): number {
  if (!slug) return missing('a connector slug');
  if (!f.provider) return missing('--provider');
  if (!(PROVIDERS as readonly string[]).includes(f.provider)) {
    process.stderr.write(`${status.err(`--provider must be one of ${PROVIDERS.join(', ')}`)}\n`);
    return 2;
  }
  try {
    if (arrayEntryExists('connectors', 'slug', slug)) {
      process.stderr.write(`${status.err(`A connector "${slug}" already exists in kortix.toml.`)}\n`);
      return 1;
    }
    // Insertion order = field order in the block.
    const fields: Record<string, unknown> = { slug };
    if (f.name) fields.name = f.name;
    fields.provider = f.provider;
    if (f.app) fields.app = f.app;
    if (f.url) fields.url = f.url;
    if (f.transport) fields.transport = f.transport;
    if (f.endpoint) fields.endpoint = f.endpoint;
    if (f.baseUrl) fields.base_url = f.baseUrl;
    if (f.spec) fields.spec = f.spec;
    if (f.credential) fields.credential = f.credential;
    if (f.authType) fields.auth = { type: f.authType };
    appendArrayBlock('connectors', fields);
    process.stdout.write(
      `${status.ok(`Added [[connectors]] ${C.bold}${slug}${C.reset} to kortix.toml`)}\n` +
        `  ${C.dim}Apply it with ${C.reset}${C.cyan}kortix ship${C.reset}${C.dim}, then set auth: ${C.reset}${C.cyan}kortix connectors credential ${slug}${C.reset}${C.dim} / ${C.reset}${C.cyan}connect ${slug}${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

function connectorRmLocal(slug: string | undefined): number {
  if (!slug) return missing('a connector slug');
  try {
    const removed = removeArrayBlock('connectors', 'slug', slug);
    if (!removed) {
      process.stderr.write(`${status.err(`No [[connectors]] "${slug}" in kortix.toml.`)}\n`);
      return 1;
    }
    process.stdout.write(
      `${status.ok(`Removed ${C.bold}${slug}${C.reset} from kortix.toml`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

function policySetLocal(mode: string | undefined): number {
  if (mode !== 'risk' && mode !== 'allow_all') return missing('--default risk|allow_all');
  try {
    setTableScalar('policy', 'default_mode', mode);
    process.stdout.write(
      `${status.ok(`[policy] default_mode → ${mode}`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

function statusCell(s: AdminConnector['status']): string {
  const color =
    s === 'active' ? C.green : s === 'error' ? C.red : s === 'needs_auth' ? C.yellow : C.faded;
  return `${color}${pad(s, 11)}${C.reset}`;
}

function sharingLabel(s: ConnectorSharing | null): string {
  if (!s) return 'project';
  if (s.mode === 'members') {
    const n = (s.memberIds?.length ?? 0) + (s.groupIds?.length ?? 0);
    return `members (${n})`;
  }
  return s.mode;
}

function reportSync(sync?: SyncResult): void {
  if (!sync) return;
  for (const e of sync.errors) process.stderr.write(`  ${status.warn(`${e.slug}: ${e.error}`)}\n`);
}

/** Accept friendly verbs (allow|ask|block) or canonical actions → canonical, else null. */
function normalizePolicyAction(v: string | undefined): 'always_run' | 'require_approval' | 'block' | null {
  switch ((v ?? '').toLowerCase()) {
    case 'allow':
    case 'always_run':
      return 'always_run';
    case 'ask':
    case 'approve':
    case 'require_approval':
      return 'require_approval';
    case 'block':
    case 'deny':
      return 'block';
    default:
      return null;
  }
}

function splitCsv(v: string | undefined): string[] {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString('utf8');
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
