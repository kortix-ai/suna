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
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import { CliError, connectorErrorPayload, out, parseExecArgs, stringValue } from '../connector-gateway/io.ts';
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
      throw new CliError(
        `cannot read args file ${path}: ${(error as Error).message}`,
        'BAD_ARGS',
      );
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

  const first = args[0]?.trim();
  if (!first) throw new CliError(CONNECTOR_CALL_USAGE, 'USAGE');

  const separator = first.indexOf('.');
  if (separator >= 0) {
    const slug = first.slice(0, separator).trim();
    const action = first.slice(separator + 1).trim();
    if (!slug || !action || args.length > 2) {
      throw new CliError(CONNECTOR_CALL_USAGE, 'USAGE');
    }
    return { slug, action, rawArgs: args[1] ?? stringValue(flags.args) };
  }

  const action = args[1]?.trim();
  if (!action || args.length > 3) {
    throw new CliError(CONNECTOR_CALL_USAGE, 'USAGE');
  }
  return { slug: first, action, rawArgs: args[2] ?? stringValue(flags.args) };
}

// Build a connector draft (ConnectorDraft on the API) from CLI flags.
function connectorDraftFromFlags(
  slug: string,
  flags: Record<string, string | true>,
): Record<string, unknown> {
  const provider = stringValue(flags.provider);
  if (!provider)
    throw new CliError(
      '--provider is required (pipedream|mcp|openapi|postman|graphql|http)',
      'USAGE',
    );
  if (!PROVIDERS.includes(provider))
    throw new CliError(`--provider must be one of ${PROVIDERS.join(', ')}`, 'USAGE');
  if (provider === 'pipedream' && flags['allow-legacy-pipedream'] === undefined) {
    throw new CliError(
      'Pipedream is legacy rollback only. Use --provider composio for managed SaaS apps. Ask the human before retrying with --allow-legacy-pipedream.',
      'LEGACY_PROVIDER_REQUIRES_APPROVAL',
    );
  }
  const name = stringValue(flags.name);
  const app = stringValue(flags.app);
  const url = stringValue(flags.url);
  const transport = stringValue(flags.transport);
  const endpoint = stringValue(flags.endpoint);
  const baseUrl = stringValue(flags['base-url']);
  const spec = stringValue(flags.spec);
  const credential = stringValue(flags.credential);
  const authType = stringValue(flags['auth-type']);
  const draft: Record<string, unknown> = { slug, provider };
  if (provider === 'pipedream') draft.allow_legacy_pipedream = true;
  if (name) draft.name = name;
  if (app) draft.app = app;
  if (url) draft.url = url;
  if (transport) draft.transport = transport;
  if (endpoint) draft.endpoint = endpoint;
  if (baseUrl) draft.baseUrl = baseUrl;
  if (spec) draft.spec = spec;
  if (credential) draft.credential = credential;
  if (authType) draft.auth = { type: authType };
  return draft;
}

/** What one subcommand handler receives: the parsed argv after `connectors`. */
interface Invocation {
  args: string[];
  flags: Record<string, string | true>;
  repeated: Record<string, (string | true)[]>;
}

type Handler = (invocation: Invocation) => Promise<void>;

async function listConnectors({ flags }: Invocation): Promise<void> {
  const connector = connectorClient(stringValue(flags.project));
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

async function discover({ args, flags }: Invocation): Promise<void> {
  const connector = connectorClient(stringValue(flags.project));
  const q = args.join(' ') || stringValue(flags.query) || '';
  const matches = await connector.search(q, {
    limit: Number(stringValue(flags.limit)) || 20,
  });
  out({
    matches: matches.map((m) => ({
      tool: m.tool,
      risk: m.risk,
      description: m.description,
    })),
  });
}

async function show({ args, flags }: Invocation): Promise<void> {
  const connector = connectorClient(stringValue(flags.project));
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

async function call({ args, flags, repeated }: Invocation): Promise<void> {
  const { slug, action, rawArgs } = parseConnectorCallInput(args, flags);
  if (flags.out === true) throw new CliError('--out needs a file path', 'USAGE');
  const connector = connectorClient(stringValue(flags.project));
  let parsed = await readCallArgs(rawArgs);
  // A valueless `--attach` is the `true` sentinel — it carries no path.
  const attach = (repeated.attach ?? []).filter((path): path is string => typeof path === 'string');
  if (flags.attach !== undefined && attach.length === 0) {
    throw new CliError('--attach needs a file path', 'USAGE');
  }
  if (attach.length > 0) {
    // Raw bytes go to attachment staging; only opaque handles enter args.
    const tool = await connector.describe(`${slug}.${action}`);
    if (!tool) throw new CliError(`unknown tool "${slug}.${action}"`, 'NOT_FOUND');
    let slot: string[] | null;
    try {
      slot = attachmentSlot(tool.inputSchema, stringValue(flags['attach-path']));
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
  const result = await callWithApprovalHandoff(connector, slug, action, parsed, {
    account: flags.account,
    approvalContext: flags.reason,
  });
  // `--out <file>`: the full result goes to the file, a summary to stdout
  // (bytes, the shape of `data`, the path). Large results stay out of the
  // agent's context, where OpenCode would truncate them.
  const outPath = stringValue(flags.out);
  out(outPath ? await saveResult(result, resolve(outPath)) : result);
}

async function upload({ args, flags }: Invocation): Promise<void> {
  // Stage one file; print the handle plus `ref`, the call-args value.
  const path = args[0];
  const slug = stringValue(flags.connector) ?? '';
  if (!path || !slug) {
    throw new CliError(
      'usage: kortix connectors upload <file> --connector <slug> [--filename <name>] [--content-type <mime>] [--inline --content-id <cid>]',
      'USAGE',
    );
  }
  const filename = stringValue(flags.filename);
  const contentType = stringValue(flags['content-type']);
  const contentId = stringValue(flags['content-id']);
  const connector = connectorClient(stringValue(flags.project));
  let uploaded;
  try {
    [uploaded] = await uploadAttachmentFiles(
      [
        {
          path: resolve(path),
          ...(filename ? { filename } : {}),
          ...(contentType ? { content_type: contentType } : {}),
          ...(flags.inline === true ? { content_disposition: 'inline' } : {}),
          ...(contentId ? { content_id: contentId } : {}),
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

async function add({ args, flags }: Invocation): Promise<void> {
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
  const res = await addConnector(draft, stringValue(flags.project));
  out({
    ok: true,
    slug,
    provider: draft.provider,
    applied: true,
    sync: res.sync,
    note: `Live now (committed to kortix.yaml on main + synced). Next: 'kortix connectors connect ${slug}' to get the auth link.`,
  });
}

async function remove({ args, flags }: Invocation): Promise<void> {
  const slug = args[0];
  if (!slug) throw new CliError('usage: kortix connectors rm <slug>', 'USAGE');
  await removeConnector(slug, stringValue(flags.project));
  out({
    ok: true,
    slug,
    removed: true,
    note: 'Removed from kortix.yaml on main + catalog.',
  });
}

async function connect({ args, flags }: Invocation): Promise<void> {
  // Start the declared connector's provider-neutral authorization and hand
  // the URL to the human. SURFACE this url in your reply — in the web UI it
  // opens a 1-click connect popup; in Slack it's a tappable link. The agent
  // never touches the credential. The connector must already be declared in
  // kortix.yaml (add it + land the change request first).
  const slug = args[0];
  if (!slug) throw new CliError('usage: kortix connectors connect <connector-slug>', 'USAGE');
  rejectBuiltinChannel(slug);
  const expires = stringValue(flags.expires);
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
    expiresInMinutes: expires ? Number(expires) : undefined,
    projectOverride: stringValue(flags.project),
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

// The object printed for every unknown (or missing) subcommand — the one
// machine-readable map of this surface.
const CONNECTORS_HELP = {
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

// `accounts` is NOT dispatched here. It is the one gateway read a human
// also runs, so it lives in connectors.ts: a table by default, and the
// same JSON payload under --json. The MCP keeps its own `accounts` tool.
const HANDLERS: Record<string, Handler> = {
  connectors: listConnectors,
  ls: listConnectors,
  discover: discover,
  search: discover,
  show: show,
  describe: show,
  call: call,
  upload: upload,
  add: add,
  create: add,
  rm: remove,
  remove: remove,
  delete: remove,
  connect: connect,
};

/** Route one `kortix connectors <subcommand>`; anything unknown gets the help object. */
async function dispatch(
  command: string,
  args: string[],
  flags: Record<string, string | true>,
  repeated: Record<string, (string | true)[]> = {},
): Promise<void> {
  const handler = HANDLERS[command];
  if (!handler) {
    out(CONNECTORS_HELP);
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
