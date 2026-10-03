import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
/**
 * `kortix connectors` — the agent's interface to every configured connector
 * (Composio / Pipedream / MCP / OpenAPI / Postman / GraphQL / HTTP), absorbed from the old in-sandbox
 * `connector` shim into the one kortix CLI.
 *
 * Three faces over ONE core (see ../connector-gateway/gateway.ts):
 *   - this CLI        (`kortix connectors call …`, the agent's primary path)
 *   - the SDK         (`@kortix/sdk`, durable TypeScript workflows)
 *   - the MCP server  (`kortix connectors mcp`, optional compatibility face)
 *
 * Thin client: it never holds a third-party credential. Every tool call goes to
 * the Kortix Connector Gateway (/v1/connectors/*), which checks sharing, resolves
 * the secret SERVER-SIDE, runs the call, and audits it. Auth comes from
 * KORTIX_TOKEN + KORTIX_API_URL, injected at sandbox spawn.
 *
 * MACHINE surface: emits JSON only (the agent parses stdout); index.ts skips the
 * host/update notices for machine-oriented connector subcommands.
 */
import { ApiError } from '@kortix/sdk';
import {
  attachmentRef,
  attachmentSlot,
  insertAttachmentHandles,
  uploadAttachmentFiles,
} from '../connector-gateway/attachments.ts';
import {
  addConnector,
  callWithApprovalHandoff,
  connectorClient,
  mintConnectLink,
  removeConnector,
} from '../connector-gateway/gateway.ts';
import { CliError, connectorErrorPayload, out, parseExecArgs } from '../connector-gateway/io.ts';
import { runConnectorMcpServer } from '../connector-gateway/mcp.ts';
import { saveResult } from '../connector-gateway/result-spill.ts';

const PROVIDERS = ['composio', 'pipedream', 'mcp', 'openapi', 'postman', 'graphql', 'http'];

// Built-in channels are never added/connected through the connector — the
// platform materializes their connectors automatically after the channel is
// wired up. Catch the slugs client-side so an agent gets pointed at the ONE
// right command instead of a generic reserved-slug error from the API.
const BUILTIN_CHANNEL_HINTS: Record<string, string> = {
  slack:
    'Slack is a built-in channel, not a connector. Run `kortix channels connect` — ' +
    'it prints a one-click "Add to Slack" install link. Once installed, its tools appear here as `kortix_slack.*`.',
  kortix_slack:
    'The Slack channel connector is materialized automatically. To (re)connect Slack, run `kortix channels connect` ' +
    'for a one-click install link.',
};

function rejectBuiltinChannel(slug: string): void {
  const hint = BUILTIN_CHANNEL_HINTS[slug];
  if (hint) throw new CliError(hint, 'BUILTIN_CHANNEL');
}

interface ConnectorCallInput {
  slug: string;
  action: string;
  rawArgs: string | undefined;
}

const CONNECTOR_CALL_USAGE =
  'usage: kortix connectors call <connector>.<action> [json-args | @args.json | -] ' +
  '[--account <label>] [--reason <text>] [--attach <file>]... [--attach-path <dotted.path>] [--out <file>] ' +
  '(split form also supported: <connector> <action> [json-args])';

/**
 * JSON args come inline, from a file (`@path`), or from stdin (`-`). The file
 * and stdin forms carry payloads larger than one argv string may be (Linux
 * caps a single argument at 128 KiB).
 */
async function readCallArgs(rawArgs: string | undefined): Promise<Record<string, unknown>> {
  if (!rawArgs) return {};
  let text = rawArgs;
  if (rawArgs === '-') {
    text = await new Response(Bun.stdin.stream()).text();
  } else if (rawArgs.startsWith('@')) {
    const path = rawArgs.slice(1);
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      throw new CliError(`cannot read args file ${path}: ${(error as Error).message}`, 'BAD_ARGS');
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError('args must be valid JSON', 'BAD_ARGS');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('args must be a JSON object', 'BAD_ARGS');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Accept the dotted tool reference returned by connectors/discover/describe.
 * Split only the first dot because action paths can contain dots.
 */
export function parseConnectorCallInput(
  args: string[],
  flags: Record<string, string | true>,
): ConnectorCallInput {
  if (flags.as) {
    throw new CliError(
      '`--as` is not supported. Connector identity is fixed by the session token. Start a new session to use another agent.',
      'AGENT_OVERRIDE_NOT_SUPPORTED',
    );
  }

  if (flags.args === true) throw new CliError(CONNECTOR_CALL_USAGE, 'USAGE');

  const first = args[0]?.trim();
  if (!first) throw new CliError(CONNECTOR_CALL_USAGE, 'USAGE');

  const separator = first.indexOf('.');
  if (separator >= 0) {
    const slug = first.slice(0, separator).trim();
    const action = first.slice(separator + 1).trim();
    if (!slug || !action || args.length > 2) {
      throw new CliError(CONNECTOR_CALL_USAGE, 'USAGE');
    }
    return { slug, action, rawArgs: args[1] ?? strFlags(flags).args };
  }

  const action = args[1]?.trim();
  if (!action || args.length > 3) {
    throw new CliError(CONNECTOR_CALL_USAGE, 'USAGE');
  }
  return { slug: first, action, rawArgs: args[2] ?? strFlags(flags).args };
}

/** The string-valued flags of a parsed argv: a valueless flag is the boolean
 *  `true` (a bare flag), never the string 'true', so a read through strFlags
 *  is the flag's value when one was given and undefined when it was bare. */
function strFlags(flags: Record<string, string | true | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

// Build a connector draft (ConnectorDraft on the API) from CLI flags.
function connectorDraftFromFlags(
  slug: string,
  rawFlags: Record<string, string | true | undefined>,
): Record<string, unknown> {
  const provider = rawFlags.provider;
  if (provider === true || !provider)
    throw new CliError(
      '--provider is required (pipedream|mcp|openapi|postman|graphql|http)',
      'USAGE',
    );
  if (!PROVIDERS.includes(provider))
    throw new CliError(`--provider must be one of ${PROVIDERS.join(', ')}`, 'USAGE');
  // A valueless flag is `true`, a valued one its string — both mean approved.
  const approved =
    rawFlags['allow-legacy-pipedream'] === true || rawFlags['allow-legacy-pipedream'] === 'true';
  if (provider === 'pipedream' && !approved) {
    throw new CliError(
      'Pipedream is legacy rollback only. Use --provider composio for managed SaaS apps. Ask the human before retrying with --allow-legacy-pipedream.',
      'LEGACY_PROVIDER_REQUIRES_APPROVAL',
    );
  }
  const flags = strFlags(rawFlags);
  const draft: Record<string, unknown> = { slug, provider };
  if (provider === 'pipedream') draft.allow_legacy_pipedream = true;
  if (flags.name) draft.name = flags.name;
  if (flags.app) draft.app = flags.app;
  if (flags.url) draft.url = flags.url;
  if (flags.transport) draft.transport = flags.transport;
  if (flags.endpoint) draft.endpoint = flags.endpoint;
  if (flags['base-url']) draft.baseUrl = flags['base-url'];
  if (flags.spec) draft.spec = flags.spec;
  if (flags.credential) draft.credential = flags.credential;
  if (flags['auth-type']) draft.auth = { type: flags['auth-type'] };
  return draft;
}

/** One dispatched `kortix connectors <command>`: its positionals, flags and the
 *  repeatable flags parseExecArgs collected. */
interface CommandCtx {
  args: string[];
  flags: Record<string, string | true>;
  repeated: Record<string, Array<string | true>>;
}

async function connectorsLs({ flags }: CommandCtx): Promise<void> {
  const connector = connectorClient(strFlags(flags).project);
  // Name/status/tool-count only — never ask for the per-action schemas.
  const connectors = await connector.catalog({ includeSchemas: false });
  out({
    connectors: connectors.map((c) => ({
      slug: c.slug,
      provider: c.provider,
      status: c.status,
      tools: c.actions.map((a) => `${c.slug}.${a.path}`),
    })),
  });
}

async function discoverTools({ args, flags }: CommandCtx): Promise<void> {
  const connector = connectorClient(strFlags(flags).project);
  const f = strFlags(flags);
  const q = args.join(' ') || f.query || '';
  const matches = await connector.search(q, {
    limit: Number(f.limit) || 20,
  });
  out({
    matches: matches.map((m) => ({
      tool: m.tool,
      risk: m.risk,
      description: m.description,
    })),
  });
}

async function showTool({ args, flags }: CommandCtx): Promise<void> {
  const connector = connectorClient(strFlags(flags).project);
  const ref = args[0];
  if (!ref || !ref.includes('.'))
    throw new CliError('usage: kortix connectors show <connector>.<action>', 'USAGE');
  const tool = await connector.describe(ref);
  if (!tool)
    throw new CliError(
      `unknown tool "${ref}" — run 'kortix connectors discover' to list tools`,
      'NOT_FOUND',
    );
  out({
    tool: tool.tool,
    risk: tool.risk,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
}

async function callTool({ args, flags, repeated }: CommandCtx): Promise<void> {
  const { slug, action, rawArgs } = parseConnectorCallInput(args, flags);
  if (flags.out === true) throw new CliError('--out needs a file path', 'USAGE');
  const connector = connectorClient(strFlags(flags).project);
  let parsed = await readCallArgs(rawArgs);
  const attach = (repeated.attach ?? []).filter((path): path is string => path !== true);
  if (flags.attach !== undefined && attach.length === 0) {
    throw new CliError('--attach needs a file path', 'USAGE');
  }
  if (attach.length > 0) {
    // Raw bytes go to attachment staging; only opaque handles enter args.
    const tool = await connector.describe(`${slug}.${action}`);
    if (!tool) throw new CliError(`unknown tool "${slug}.${action}"`, 'NOT_FOUND');
    let slot: string[] | null;
    try {
      slot = attachmentSlot(tool.inputSchema, strFlags(flags)['attach-path']);
    } catch (error) {
      throw new CliError((error as Error).message, 'USAGE');
    }
    if (!slot) {
      throw new CliError(
        `${slug}.${action} does not accept attachments: its input schema has no \`attachments\` array. Pass --attach-path to name the array field.`,
        'ATTACHMENTS_UNSUPPORTED',
      );
    }
    try {
      const handles = await uploadAttachmentFiles(
        attach.map((path) => ({ path: resolve(path) })),
        connector,
        { connector: slug },
      );
      parsed = insertAttachmentHandles(
        parsed,
        slot,
        handles.map((handle) => attachmentRef(handle.attachment_id)),
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new CliError((error as Error).message, 'BAD_ATTACHMENT');
    }
  }
  // A gated call returns its authenticated approval URL immediately. The
  // server sends the decision back into the session after a human acts.
  //
  // `--account` picks WHICH connected account to run as when the connector
  // holds more than one (the project's shared account and each member's
  // own). Omitted runs as the default, which is every call's old behavior.
  // A name that matches nothing is denied and the denial lists what was
  // available — it never falls back to a different account.
  const f = strFlags(flags);
  const result = await callWithApprovalHandoff(connector, slug, action, parsed, {
    account: f.account,
    approvalContext: f.reason,
  });
  // `--out <file>`: the full result goes to the file, a summary to stdout
  // (bytes, the shape of `data`, the path). Large results stay out of the
  // agent's context, where OpenCode would truncate them.
  out(f.out ? await saveResult(result, resolve(f.out)) : result);
}

async function uploadFile({ args, flags }: CommandCtx): Promise<void> {
  // Stage one file; print the handle plus `ref`, the call-args value.
  const path = args[0];
  const f = strFlags(flags);
  const slug = f.connector ?? '';
  if (!path || !slug) {
    throw new CliError(
      'usage: kortix connectors upload <file> --connector <slug> [--filename <name>] [--content-type <mime>] [--inline --content-id <cid>]',
      'USAGE',
    );
  }
  const connector = connectorClient(strFlags(flags).project);
  let uploaded;
  try {
    [uploaded] = await uploadAttachmentFiles(
      [
        {
          path: resolve(path),
          ...(f.filename ? { filename: f.filename } : {}),
          ...(f['content-type'] ? { content_type: f['content-type'] } : {}),
          ...(flags.inline === true ? { content_disposition: 'inline' } : {}),
          ...(f['content-id'] ? { content_id: f['content-id'] } : {}),
        },
      ],
      connector,
      { connector: slug },
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new CliError((error as Error).message, 'BAD_ATTACHMENT');
  }
  out({ ok: true, ...uploaded, ref: attachmentRef(uploaded!.attachment_id) });
}

async function addConnectorCommand({ args, flags }: CommandCtx): Promise<void> {
  // Add (or update) a connector on the project NOW — committed to
  // kortix.yaml on main + synced server-side, exactly like the dashboard's
  // "Add app". No change request needed; it's live this session. Then run
  // `kortix connectors connect <slug>` to surface the provider auth link.
  const slug = args[0];
  if (!slug)
    throw new CliError(
      'usage: kortix connectors add <slug> --provider <p> [--app <app>] [--url <url>] …',
      'USAGE',
    );
  rejectBuiltinChannel(slug);
  const draft = connectorDraftFromFlags(slug, flags);
  const res = await addConnector(draft, strFlags(flags).project);
  out({
    ok: true,
    slug,
    provider: draft.provider,
    applied: true,
    sync: res.sync,
    note: `Live now (committed to kortix.yaml on main + synced). Next: 'kortix connectors connect ${slug}' to get the auth link.`,
  });
}

async function removeConnectorCommand({ args, flags }: CommandCtx): Promise<void> {
  const slug = args[0];
  if (!slug) throw new CliError('usage: kortix connectors rm <slug>', 'USAGE');
  await removeConnector(slug, strFlags(flags).project);
  out({
    ok: true,
    slug,
    removed: true,
    note: 'Removed from kortix.yaml on main + catalog.',
  });
}

async function connectConnectorCommand({ args, flags }: CommandCtx): Promise<void> {
  // Start the declared connector's provider-neutral authorization and hand
  // the URL to the human. SURFACE this url in your reply — in the web UI it
  // opens a 1-click connect popup; in Slack it's a tappable link. The agent
  // never touches the credential. The connector must already be declared in
  // kortix.yaml (add it + land the change request first).
  const slug = args[0];
  if (!slug) throw new CliError('usage: kortix connectors connect <connector-slug>', 'USAGE');
  rejectBuiltinChannel(slug);
  const f = strFlags(flags);
  const expires = f.expires ? Number(f.expires) : undefined;
  // `--owner` picks WHO the new account belongs to: `me` (the human who
  // opens the link — the default) or `project` (shared with every member).
  // An agent should leave it alone unless the human asked for a shared
  // account; minting a shared one needs project.connector.write.
  const owner: 'me' | 'project' | undefined =
    flags.owner === 'me' || flags.owner === 'project' ? flags.owner : undefined;
  if (flags.owner !== undefined && owner === undefined) {
    throw new CliError('--owner must be me or project', 'USAGE');
  }
  const link = await mintConnectLink({
    slug,
    expiresInMinutes: expires,
    projectOverride: f.project,
    ...(owner ? { owner } : {}),
  });
  out({
    ok: true,
    slug: link.slug,
    owner: owner ?? 'me',
    app: link.app,
    url: link.url,
    expires_at: link.expires_at,
    provider: link.provider,
    connected: link.connected,
    is_no_auth: link.is_no_auth,
    session_id: link.session_id,
    connection_id: link.connection_id,
    request_id: link.request_id,
    note: link.url
      ? 'Surface this url to the human. It opens the configured provider authorization flow. No keys touch the sandbox.'
      : 'The connector is already connected or requires no authentication.',
  });
}

function connectorHelp(): Record<string, unknown> {
  return {
    name: 'kortix connectors',
    description:
      'One interface to every configured connector. Calls run server-side; no secrets in the sandbox.',
    commands: {
      ls: 'kortix connectors ls — list connectors + tools this session can use',
      discover: 'kortix connectors discover "<intent>" — search tools by natural language',
      show: "kortix connectors show <connector>.<action> — show a tool's input schema",
      call: "kortix connectors call <connector> <action> '<json-args>'|@args.json|- [--account <label|id|me|project>] [--reason <text>] [--attach <file>]... [--attach-path <dotted.path>] — run a tool or return its approval link; the result echoes the account it ran as. With several accounts and none named/pinned, denied with reason account_required — name --account or pin a default. --attach stages a file from /workspace/{output,artifacts,reports,deliverables} and appends its reference to the action's attachments array (e.g. Microsoft Graph body.message.attachments); the gateway builds the provider's attachment item. Never put base64 in args. --reason <text> tells the human approver what the call does when policy holds it (who it emails, what it says, what it deletes); always pass it for writes whose args are only ids (send_draft, delete, merge). --out <file> writes the full JSON result to <file> and prints only { saved_to, bytes, shape } — use it for list/search calls that can return more than ~16 KB, then query the file with jq or bun",
      upload:
        'kortix connectors upload <file> --connector <slug> — stage one file; prints `ref`, the value {"$kortix_attachment":"<id>"}. Put it in call args: as an attachments[] element it becomes the provider attachment item, in a string field (contentBytes, content) it becomes the base64. Single-use, expires in 24 h',
      add: 'kortix connectors add <slug> --provider composio --app <toolkit> — add a managed app connector NOW (no CR), then connect',
      rm: 'kortix connectors rm <slug> — remove a connector from the project',
      accounts:
        'kortix connectors accounts <connector> [--json] [--default <label|id>] — the connected accounts a call may run as, default first; each is shared with the project or private to one member (the names --account takes). --default pins one so unnamed calls use it',
      connect:
        'kortix connectors connect <connector-slug> [--owner me|project] — start the connector provider authorization and hand the URL to the human; --owner project makes the account shared with every member',
      mcp: 'kortix connectors mcp — run the optional stdio MCP compatibility server',
    },
  };
}

const COMMANDS: Record<string, (ctx: CommandCtx) => Promise<void>> = {
  connectors: connectorsLs,
  ls: connectorsLs,
  discover: discoverTools,
  search: discoverTools,
  show: showTool,
  describe: showTool,
  call: callTool,
  upload: uploadFile,
  add: addConnectorCommand,
  create: addConnectorCommand,
  rm: removeConnectorCommand,
  remove: removeConnectorCommand,
  delete: removeConnectorCommand,
  connect: connectConnectorCommand,
};

/** Dispatch one `kortix connectors <command>`. An unknown (or absent) command
 *  falls through to the help object — the machine surface's usage. */
async function dispatch(
  command: string,
  args: string[],
  flags: Record<string, string | true>,
  repeated: Record<string, Array<string | true>> = {},
): Promise<void> {
  const handler = COMMANDS[command];
  if (!handler) {
    out(connectorHelp());
    return;
  }
  await handler({ args, flags, repeated });
}

/** `argv` is everything after the `connectors` token. */
export async function runConnector(argv: string[]): Promise<number> {
  const { command, args, flags, repeated } = parseExecArgs(argv);

  // The MCP server owns stdin/stdout for JSON-RPC; run it directly.
  if (command === 'mcp') {
    return runConnectorMcpServer();
  }

  try {
    await dispatch(command, args, flags, repeated);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      // VERBATIM: a 403 denial carries the remedy (available_accounts, hint,
      // connect_url). Printing only `err.message` threw all of it away.
      out(connectorErrorPayload(err));
      return 1;
    }
    if (err instanceof CliError) {
      out(connectorErrorPayload(err, err.code));
      return err.exitCode;
    }
    out({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return 1;
  }
}
