import {
  emitJson,
  resolveWorkspaceContext,
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
import { setConnectorSecretBinding } from '@kortix/sdk';
import { withKortixScope } from '../api/sdk.ts';
import { C, help, pad, status } from '../style.ts';
import { runConnector } from './connector-gateway.ts';

// ── Shapes (mirror apps/api/src/connectors) ───────────────────────────────────

type Provider = 'pipedream' | 'mcp' | 'openapi' | 'postman' | 'graphql' | 'http';

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
  /** Always `shared` — `per_user` (each member's own) was removed 2026-07-05. */
  credentialMode: 'shared';
  actions: ConnectorAction[];
  authSecret: string | null;
  secretSet: boolean;
}

interface SyncResult {
  synced: number;
  errors: Array<{ slug: string; error: string }>;
}

interface Connection {
  connection_id: string;
  connector_alias: string;
  owner_type: 'project' | 'agent' | 'member' | 'subject' | 'external';
  owner_id: string | null;
  label?: string;
  status: 'active' | 'revoked' | 'error';
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}

const PROVIDERS: readonly Provider[] = ['pipedream', 'mcp', 'openapi', 'postman', 'graphql', 'http'];

const HELP = help`Usage: kortix connectors <subcommand> [options]

Manage the workspace's connectors — the external systems agents call as tools
(Pipedream apps, MCP servers, OpenAPI/Postman/GraphQL/HTTP endpoints). Mirrors the
dashboard's Customize → Connectors. Connectors are workspace-wide visible; the
only access gate is which AGENTS may call one (\`kortix agents scope\` /
\`[[agents]].connectors\` in kortix.yaml) — see \`kortix grants\`.

Config lives in kortix.yaml (the source of truth): \`add\`/\`rm\`/\`policy set\`
edit your LOCAL file — run \`kortix ship\` to apply, then \`sync\` to reconcile.
Only credentials, OAuth, and reads talk to the cloud.

Subcommands:
  ls [--session <id>] [--json]      List workspace or session-bound connectors.
  show <slug>[.<action>] [--json]   Show a connector or one action schema.
  discover <intent> [--json]        Search session tools by intent.
  call <slug> <action> [json]       Invoke one connector action.
  connections <subcommand>          Manage configured connector connections.
  add <slug> --provider <p> [...]   Add a [[connectors]] block to kortix.yaml.
                                    Add --apply to skip ship/CR and apply it
                                    instantly on the cloud workspace (commit to
                                    main + sync, like the dashboard).
  rm <slug> [--apply]               Remove a [[connectors]] block from kortix.yaml
                                    (or --apply to remove on the cloud now).
  rename <slug> <name…>             Set a connector's display name (applies now).
  mode <slug> shared                 Set the connection mode (applies now + re-syncs; shared is the only mode).
  sync                              Reconcile the catalog from the shipped kortix.yaml.
  credential <slug> [value]         Set a connector's credential (prompts if
                                    no value; reads stdin with \`-\`).
  secret <slug> <identifier>        Use a workspace secret as this connector's
                                    server-side credential. Add --clear to
                                    remove the binding.
  connect <slug> [--expires <min>]  Start a Pipedream 1-click connection.
  apps [<query>] [--json]           Browse the Pipedream app catalog.
  policy ls [--json]                Show workspace-wide execution policies.
  policy set --default <risk|allow_all>   Set the default execution mode.
  policy <slug> ls [--json]         Show one connector's tool-call rules.
  policy <slug> set <match> <act>   Allow|ask|block a tool/glob/regex (applies now).
                                    <match> = tool name, glob (send_*) or /regex/.
  policy <slug> rm <match>          Remove a connector rule.
  policy <slug> clear               Remove all of a connector's rules.
  mcp                               Run the stdio MCP server.

Add options (provider-specific):
  --name <label>           Human label (default: slug).
  --provider <p>           ${PROVIDERS.join('|')}.
  --app <slug>             Pipedream app slug (provider=pipedream).
  --url <url>              MCP server URL (provider=mcp).
  --transport <http|sse>   MCP transport (provider=mcp).
  --endpoint <url>         GraphQL endpoint (provider=graphql).
  --base-url <url>         HTTP base URL (provider=http).
  --spec <url|path>        OpenAPI/Postman/GraphQL/HTTP spec or source ref.
  --auth-type <t>          Manual override: none|bearer|basic|custom|oauth1.
                           Omit to auto-detect from the source; none opts out.
  --credential <mode>      shared (the only mode).

Global:
  --workspace <id>     Operate on this workspace id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

const CONNECTIONS_HELP = help`Usage: kortix connectors connections <subcommand> [options]

Manage connections — configured authorizations for workspace connectors.

Subcommands:
  ls [--all] [--json]               List visible connections. --all lists the
                                    manage-gated owner roster.
  add <connector> <label> [options] Create or reconcile a connection.
  credential <id> [value|-]         Set a connection credential.
  revoke <id>                       Revoke a connection.
  activate <id>                     Activate a connection.
  default <id>                      Make a connection its owner-scope default.
  connect <id> [options]            Start Pipedream OAuth for a connection.
  finalize <id> [--json]            Finalize Pipedream OAuth for a connection.

Add options:
  --owner <type>       workspace|agent|member|subject|external (default: workspace).
  --owner-id <id>      Required for non-workspace owners.
  --mine               Derive a member owner from the current human token.
  --metadata <json>    Connection metadata as a JSON object.

Pipedream options:
  --success-redirect <url>   Redirect after a successful connection.
  --error-redirect <url>     Redirect after a failed connection.

Global:
  --workspace <id>       Operate on this workspace id (default: linked).
  --host <name>        Operate against a non-default Kortix host.
  --json               Emit the API response as JSON.
  -h, --help           Show this help.
`;

export async function runConnectors(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  if (
    sub === 'connections' &&
    (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help')
  ) {
    process.stdout.write(CONNECTIONS_HELP);
    return rest.length === 0 ? 2 : 0;
  }
  if (sub === 'discover' || sub === 'call' || sub === 'mcp') {
    return runConnector([sub, ...rest]);
  }
  if (sub === 'show' && rest[0]?.includes('.')) {
    return runConnector(['show', ...rest]);
  }
  if ((sub === 'ls' || sub === 'list') && rest.includes('--session')) {
    const forwarded = rest.filter(
      (arg, index) => arg !== '--session' && rest[index - 1] !== '--session',
    );
    return runConnector(['ls', ...forwarded]);
  }
  let f: Record<string, string | undefined> = {};
  let asStdin = false;
  let json = false;
  let applyRemote = false;
  let clearSecretBinding = false;
  let allConnections = false;
  let mine = false;
  try {
    json = takeFlagBool(rest, ['--json']);
    applyRemote = takeFlagBool(rest, ['--apply']);
    clearSecretBinding = takeFlagBool(rest, ['--clear']);
    allConnections = takeFlagBool(rest, ['--all']);
    mine = takeFlagBool(rest, ['--mine']);
    f.workspace = takeFlagValue(rest, ['--workspace', '--project']);
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
    f.cursor = takeFlagValue(rest, ['--cursor']);
    f.default = takeFlagValue(rest, ['--default']);
    f.expires = takeFlagValue(rest, ['--expires']);
    f.owner = takeFlagValue(rest, ['--owner']);
    f.ownerId = takeFlagValue(rest, ['--owner-id']);
    f.metadata = takeFlagValue(rest, ['--metadata']);
    f.successRedirect = takeFlagValue(rest, ['--success-redirect']);
    f.errorRedirect = takeFlagValue(rest, ['--error-redirect']);
    asStdin = takeFlagBool(rest, ['--stdin']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  // ── Config mutations edit the LOCAL kortix.yaml (the source of truth). No
  //    cloud call, no auth — you `kortix ship` to apply. Only credentials,
  //    OAuth, reconcile + reads talk to the cloud. ───────────────────
  //    `--apply` skips the local-edit + ship/CR flow and applies the change
  //    instantly on the cloud workspace (commit to kortix.yaml on main + sync,
  //    exactly like the dashboard) — handled in the switch below.
  if ((sub === 'add' || sub === 'create') && !applyRemote) return connectorAddLocal(positional[0], f);
  if ((sub === 'rm' || sub === 'remove' || sub === 'delete') && !applyRemote) return connectorRmLocal(positional[0]);
  if ((sub === 'policy' || sub === 'policies') && positional[0] === 'set') return policySetLocal(f.default);

  const ctx = await resolveWorkspaceContext({ workspaceArg: f.workspace, hostArg: f.host });
  if (!ctx) return 1;
  const ex = `/connectors/workspaces/${ctx.workspaceId}`;

  try {
    if (sub === 'connections') {
      return await runConnections({
        action: positional[0],
        positional: positional.slice(1),
        ctx,
        flags: f,
        json,
        all: allConnections,
        mine,
        asStdin,
        rawArgs: rest,
      });
    }
    switch (sub) {
      // `--apply` paths: mutate the cloud workspace directly (commit to
      // kortix.yaml on main + sync, like the dashboard) — no local edit, no CR.
      case 'add':
      case 'create': {
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        if (!f.provider) return missing('--provider');
        if (!(PROVIDERS as readonly string[]).includes(f.provider)) {
          return missing(`--provider ${PROVIDERS.join('|')}`);
        }
        const draft: Record<string, unknown> = { slug, provider: f.provider };
        if (f.name) draft.name = f.name;
        if (f.app) draft.app = f.app;
        if (f.url) draft.url = f.url;
        if (f.transport) draft.transport = f.transport;
        if (f.endpoint) draft.endpoint = f.endpoint;
        if (f.baseUrl) draft.baseUrl = f.baseUrl;
        if (f.spec) draft.spec = f.spec;
        if (f.credential) draft.credential = f.credential;
        if (f.authType) draft.auth = { type: f.authType };
        const resp = await ctx.client.post<{
          ok: boolean;
          sync?: unknown;
          authDiscovery?: { status: string; recommended?: { type?: string } | null };
        }>(`${ex}/connectors`, draft);
        if (json) { emitJson(resp); return 0; }
        process.stdout.write(
          `${status.ok(`${C.bold}${slug}${C.reset} live on the workspace`)} ${C.dim}(committed to kortix.yaml on main + synced)${C.reset}\n` +
            (resp.authDiscovery?.recommended?.type
              ? `  ${C.dim}Authentication: ${C.reset}${resp.authDiscovery.recommended.type}${C.dim} (auto-detected; set the credential next)${C.reset}\n`
              : '') +
            `  ${C.dim}Next: ${C.reset}${C.cyan}kortix connectors credential ${slug}${C.reset}\n`,
        );
        return 0;
      }
      case 'rm':
      case 'remove':
      case 'delete': {
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        await ctx.client.delete(`${ex}/connectors/${encodeURIComponent(slug)}`);
        process.stdout.write(`${status.ok(`Removed ${C.bold}${slug}${C.reset}`)} ${C.dim}(kortix.yaml on main + catalog)${C.reset}\n`);
        return 0;
      }
      case 'ls':
      case 'list': {
        const { connectors } = await ctx.client.get<{ connectors: AdminConnector[] }>(`${ex}/connectors`);
        if (json) {
          emitJson({ connectors });
          return 0;
        }
        if (connectors.length === 0) {
          process.stdout.write(
            `  ${C.dim}No connectors. Add one: ${C.reset}${C.cyan}kortix connectors add <slug> --provider mcp --url …${C.reset}\n`,
          );
          return 0;
        }
        const slugW = Math.max(...connectors.map((c) => c.slug.length), 4);
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}${pad('SLUG', slugW)}   STATUS       PROVIDER     CRED        TOOLS${C.reset}\n`,
        );
        for (const c of connectors) {
          process.stdout.write(
            `  ${pad(c.slug, slugW)}   ${statusCell(c.status)}  ${pad(c.provider, 11)}  ${pad(c.credentialMode, 9)}  ${pad(String(c.actions.length), 5)}\n`,
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
        if (json) {
          emitJson(c);
          return 0;
        }
        process.stdout.write(`\n  ${C.bold}${c.name}${C.reset} ${C.faded}(${c.slug})${C.reset}\n`);
        process.stdout.write(`  ${C.dim}provider ${C.reset}${c.provider}   ${C.dim}status ${C.reset}${statusCell(c.status)}   ${C.dim}cred ${C.reset}${c.credentialMode}${c.secretSet ? ` ${C.green}(set)${C.reset}` : ''}\n\n`);
        if (c.actions.length === 0) {
          const message =
            c.provider === 'http' && !c.actions.length
              ? 'No tools are available. Add --spec to define HTTP actions.'
              : 'No tools materialized yet — run `kortix connectors sync`.';
          process.stdout.write(`  ${C.dim}${message}${C.reset}\n\n`);
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
      case 'secret': {
        const input = connectorSecretBindingInput(positional, clearSecretBinding);
        if ('error' in input) return missing(input.error);
        await withKortixScope(ctx.auth, () =>
          setConnectorSecretBinding(ctx.workspaceId, input.slug, input.secretIdentifier),
        );
        process.stdout.write(
          input.secretIdentifier
            ? `${status.ok(`Secret ${C.bold}${input.secretIdentifier}${C.reset} bound to ${C.bold}${input.slug}${C.reset}`)}\n`
            : `${status.ok(`Secret binding removed from ${C.bold}${input.slug}${C.reset}`)}\n`,
        );
        return 0;
      }
      case 'connect': {
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        const expires = f.expires === undefined ? undefined : Number(f.expires);
        if (expires !== undefined && (!Number.isFinite(expires) || expires <= 0)) {
          return missing('--expires <positive minutes>');
        }
        const resp = await ctx.client.post<{
          url: string;
          slug: string;
          app: string | null;
          expires_at: string;
        }>(`/workspaces/${ctx.workspaceId}/connect-requests`, {
          slug,
          ...(expires === undefined ? {} : { expires_in_minutes: expires }),
        });
        if (json) {
          emitJson(resp);
          return 0;
        }
        process.stdout.write(
          `\n  ${C.bold}Connect ${slug}${C.reset}\n` +
            `  ${C.cyan}${resp.url}${C.reset}\n\n` +
            `  ${C.dim}Expires ${resp.expires_at}. The connection finalizes automatically.${C.reset}\n\n`,
        );
        return 0;
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
        // `per_user` (each member brings their own) was removed 2026-07-05
        // (docs/specs/2026-07-05-agent-first-config-unification.md §2.5) —
        // `shared` is the only mode; the route stays as a restricted no-op.
        const slug = positional[0];
        if (!slug) return missing('a connector slug');
        const mode = positional[1] ?? f.credential;
        if (mode === 'per_user') {
          process.stderr.write(`${status.err('per_user credential mode was removed — connectors are always shared now')}\n`);
          return 1;
        }
        if (mode !== 'shared') return missing('<shared>');
        await ctx.client.put(`${ex}/connectors/${encodeURIComponent(slug)}/credential-mode`, { mode });
        process.stdout.write(`${status.ok(`Connection mode for ${C.bold}${slug}${C.reset} → ${mode}`)}\n`);
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
        if (json) {
          emitJson(resp);
          return 0;
        }
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
        // Workspace-wide: `policy ls`. (`policy set --default` is handled earlier.)
        if (a0 === 'ls' || a0 === 'list') {
          const resp = await ctx.client.get<{
            policies: { match: string; action: string }[];
            defaultMode: string;
          }>(`${ex}/policies`);
          if (json) {
            emitJson(resp);
            return 0;
          }
          process.stdout.write(`\n  ${C.dim}default mode: ${C.reset}${C.bold}${resp.defaultMode}${C.reset}\n`);
          if (resp.policies.length === 0) {
            process.stdout.write(`  ${C.dim}No explicit workspace policies.${C.reset}\n\n`);
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
          const resp = await load();
          if (json) {
            emitJson(resp);
            return 0;
          }
          const { policies } = resp;
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

async function runConnections(input: {
  action: string | undefined;
  positional: string[];
  ctx: NonNullable<Awaited<ReturnType<typeof resolveWorkspaceContext>>>;
  flags: Record<string, string | undefined>;
  json: boolean;
  all: boolean;
  mine: boolean;
  asStdin: boolean;
  rawArgs: string[];
}): Promise<number> {
  const { action, positional, ctx, flags, json, all, mine, asStdin, rawArgs } = input;
  if (!action || action === '-h' || action === '--help') {
    process.stdout.write(CONNECTIONS_HELP);
    return action ? 0 : 2;
  }

  const base = `/workspaces/${ctx.workspaceId}/connections`;
  switch (action) {
    case 'ls':
    case 'list': {
      const response = await ctx.client.get<{ connections: Connection[] }>(
        all ? `${base}/all` : base,
      );
      if (json) {
        emitJson(response);
        return 0;
      }
      if (response.connections.length === 0) {
        process.stdout.write(`  ${C.dim}No connections.${C.reset}\n`);
        return 0;
      }
      const connectorWidth = Math.max(
        9,
        ...response.connections.map((connection) => connection.connector_alias.length),
      );
      const labelWidth = Math.max(
        5,
        ...response.connections.map((connection) => (connection.label ?? '').length),
      );
      process.stdout.write('\n');
      process.stdout.write(
        `  ${C.dim}${pad('CONNECTOR', connectorWidth)}  ${pad('LABEL', labelWidth)}  OWNER     STATUS   DEFAULT  CONNECTION ID${C.reset}\n`,
      );
      for (const connection of response.connections) {
        process.stdout.write(
          `  ${pad(connection.connector_alias, connectorWidth)}  ${pad(connection.label ?? '—', labelWidth)}  ` +
            `${pad(connection.owner_type, 9)} ${pad(connection.status, 8)} ` +
            `${pad(connection.is_default ? 'yes' : 'no', 8)} ${connection.connection_id}\n`,
        );
      }
      process.stdout.write(
        `\n  ${C.dim}${response.connections.length} connection${response.connections.length === 1 ? '' : 's'}${C.reset}\n\n`,
      );
      return 0;
    }
    case 'add':
    case 'create': {
      const connectorAlias = positional[0];
      const label = positional[1];
      if (!connectorAlias) return missing('a connector slug');
      if (!label) return missing('a connection label');
      if (mine && (flags.owner || flags.ownerId)) {
        return invalid('--mine cannot be combined with --owner or --owner-id');
      }
      const metadata = parseMetadata(flags.metadata);
      if (metadata instanceof Error) return invalid(metadata.message);
      const body: Record<string, unknown> = {
        connector_alias: connectorAlias,
        label,
        ...(metadata === undefined ? {} : { metadata }),
      };
      let path = base;
      if (mine) {
        path = `${base}/me`;
      } else {
        const requestedOwnerType = flags.owner ?? 'workspace';
        if (!['workspace', 'project', 'agent', 'member', 'subject', 'external'].includes(requestedOwnerType)) {
          return invalid('--owner must be workspace, agent, member, subject, or external');
        }
        const ownerType = requestedOwnerType === 'workspace' ? 'project' : requestedOwnerType;
        if (ownerType === 'project' && flags.ownerId) {
          return invalid('--owner-id is not valid for a workspace connection');
        }
        if (ownerType !== 'project' && !flags.ownerId) {
          return missing('--owner-id for a non-workspace connection');
        }
        body.owner_type = ownerType;
        if (flags.ownerId) body.owner_id = flags.ownerId;
      }
      const response = await ctx.client.post<Connection>(path, body);
      if (json) {
        emitJson(response);
        return 0;
      }
      process.stdout.write(
        `${status.ok(`Connection ${C.bold}${response.connection_id}${C.reset} configured for ${connectorAlias}`)}\n`,
      );
      return 0;
    }
    case 'credential':
    case 'cred': {
      const connectionId = positional[0];
      if (!connectionId) return missing('a connection id');
      const wantStdin = asStdin || rawArgs.includes('-');
      let value = positional[1];
      if (wantStdin) {
        value = (await readStdin()).replace(/\n$/, '');
      } else if (!value) {
        value = await promptSecret(`  value for connection ${C.bold}${connectionId}${C.reset}`);
      }
      if (!value) return invalid('No value provided.');
      const response = await ctx.client.put<{ ok: true }>(
        `${base}/${encodeURIComponent(connectionId)}/credential`,
        { value },
      );
      if (json) emitJson(response);
      else process.stdout.write(`${status.ok(`Credential set for connection ${C.bold}${connectionId}${C.reset}`)}\n`);
      return 0;
    }
    case 'revoke':
    case 'activate':
    case 'default': {
      const connectionId = positional[0];
      if (!connectionId) return missing('a connection id');
      const response = await ctx.client.put<{ ok: true }>(
        `${base}/${encodeURIComponent(connectionId)}/${action}`,
        {},
      );
      if (json) emitJson(response);
      else process.stdout.write(`${status.ok(`${connectionActionPastTense(action)} connection ${C.bold}${connectionId}${C.reset}`)}\n`);
      return 0;
    }
    case 'connect': {
      const connectionId = positional[0];
      if (!connectionId) return missing('a connection id');
      const body = {
        ...(flags.successRedirect ? { success_redirect_uri: flags.successRedirect } : {}),
        ...(flags.errorRedirect ? { error_redirect_uri: flags.errorRedirect } : {}),
      };
      const response = await ctx.client.post<{
        token?: string;
        app?: string;
        connectUrl?: string;
      }>(`${base}/${encodeURIComponent(connectionId)}/connect`, body);
      if (json) {
        emitJson(response);
        return 0;
      }
      if (response.connectUrl) process.stdout.write(`${response.connectUrl}\n`);
      else emitJson(response);
      return 0;
    }
    case 'finalize': {
      const connectionId = positional[0];
      if (!connectionId) return missing('a connection id');
      const response = await ctx.client.post<{ connected: boolean; accountId?: string }>(
        `${base}/${encodeURIComponent(connectionId)}/connect/finalize`,
        {},
      );
      if (json) emitJson(response);
      else {
        process.stdout.write(
          response.connected
            ? `${status.ok(`Connected ${C.bold}${connectionId}${C.reset}`)}\n`
            : `${status.warn(`Connection ${connectionId} is not ready`)}\n`,
        );
      }
      return response.connected ? 0 : 1;
    }
    default:
      process.stderr.write(
        `${status.err(`unknown connections subcommand "${action}"`)}\n\n${CONNECTIONS_HELP}`,
      );
      return 2;
  }
}

function parseMetadata(value: string | undefined): Record<string, unknown> | undefined | Error {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Error('--metadata must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    return new Error('--metadata must be valid JSON');
  }
}

function connectionActionPastTense(action: 'revoke' | 'activate' | 'default'): string {
  if (action === 'revoke') return 'Revoked';
  if (action === 'activate') return 'Activated';
  return 'Set as default';
}

// ── Local kortix.yaml config edits (source of truth; no cloud round-trip) ────

function connectorAddLocal(slug: string | undefined, f: Record<string, string | undefined>): number {
  if (!slug) return missing('a connector slug');
  if (!f.provider) return missing('--provider');
  if (!(PROVIDERS as readonly string[]).includes(f.provider)) {
    process.stderr.write(`${status.err(`--provider must be one of ${PROVIDERS.join(', ')}`)}\n`);
    return 2;
  }
  try {
    if (arrayEntryExists('connectors', 'slug', slug)) {
      process.stderr.write(`${status.err(`A connector "${slug}" already exists in kortix.yaml.`)}\n`);
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
      `${status.ok(`Added [[connectors]] ${C.bold}${slug}${C.reset} to kortix.yaml`)}\n` +
        `  ${C.dim}Apply it with ${C.reset}${C.cyan}kortix ship${C.reset}${C.dim}; authentication will be detected from the source unless --auth-type overrides it.${C.reset}\n` +
        `  ${C.dim}Then set the credential with ${C.reset}${C.cyan}kortix connectors credential ${slug}${C.reset}\n`,
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
      process.stderr.write(`${status.err(`No [[connectors]] "${slug}" in kortix.yaml.`)}\n`);
      return 1;
    }
    process.stdout.write(
      `${status.ok(`Removed ${C.bold}${slug}${C.reset} from kortix.yaml`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
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

export function connectorSecretBindingInput(
  positional: string[],
  clear: boolean,
): { slug: string; secretIdentifier: string | null } | { error: string } {
  const slug = positional[0];
  if (!slug) return { error: 'a connector slug' };
  const secretIdentifier = positional[1];
  if (clear && secretIdentifier) return { error: 'Do not pass a secret identifier with --clear.' };
  if (clear) return { slug, secretIdentifier: null };
  if (!secretIdentifier) return { error: 'a secret identifier' };
  return { slug, secretIdentifier };
}

function statusCell(s: AdminConnector['status']): string {
  const color =
    s === 'active' ? C.green : s === 'error' ? C.red : s === 'needs_auth' ? C.yellow : C.faded;
  return `${color}${pad(s, 11)}${C.reset}`;
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

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString('utf8');
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}

function invalid(message: string): number {
  process.stderr.write(`${status.err(message)}\n`);
  return 2;
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
