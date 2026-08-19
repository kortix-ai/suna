/**
 * `kortix connectors` — the agent's interface to every configured connector
 * (Pipedream / MCP / OpenAPI / Postman / GraphQL / HTTP), absorbed from the old in-sandbox
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
 * KORTIX_CLI_TOKEN + KORTIX_API_URL, injected at sandbox spawn.
 *
 * MACHINE surface: emits JSON only (the agent parses stdout); index.ts skips the
 * host/update notices for machine-oriented connector subcommands.
 */
import { ApiError } from '@kortix/sdk';
import {
  addConnector,
  callWithApprovalHandoff,
  connectorClient,
  mintConnectLink,
  removeConnector,
} from '../connector-gateway/gateway.ts';
import { CliError, out, parseExecArgs } from '../connector-gateway/io.ts';
import { runConnectorMcpServer } from '../connector-gateway/mcp.ts';

const PROVIDERS = ['pipedream', 'mcp', 'openapi', 'postman', 'graphql', 'http'];

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
  'usage: kortix connectors call <connector>.<action> [json-args] ' +
  '(split form also supported: <connector> <action> [json-args])';

/**
 * Accept the dotted tool reference returned by connectors/discover/describe.
 * Split only the first dot because action paths can contain dots.
 */
export function parseConnectorCallInput(
  args: string[],
  flags: Record<string, string>,
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
    return { slug, action, rawArgs: args[1] ?? flags.args };
  }

  const action = args[1]?.trim();
  if (!action || args.length > 3) {
    throw new CliError(CONNECTOR_CALL_USAGE, 'USAGE');
  }
  return { slug: first, action, rawArgs: args[2] ?? flags.args };
}

// Build a connector draft (ConnectorDraft on the API) from CLI flags.
function connectorDraftFromFlags(slug: string, flags: Record<string, string | undefined>): Record<string, unknown> {
  const provider = flags.provider;
  if (!provider) throw new CliError('--provider is required (pipedream|mcp|openapi|postman|graphql|http)', 'USAGE');
  if (!PROVIDERS.includes(provider)) throw new CliError(`--provider must be one of ${PROVIDERS.join(', ')}`, 'USAGE');
  const draft: Record<string, unknown> = { slug, provider };
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

async function dispatch(command: string, args: string[], flags: Record<string, string>): Promise<void> {
  switch (command) {
    case 'connectors':
    case 'ls': {
      const connector = connectorClient(flags.project);
      const connectors = await connector.catalog();
      out({
        connectors: connectors.map((c) => ({
          slug: c.slug,
          provider: c.provider,
          status: c.status,
          tools: c.actions.map((a) => `${c.slug}.${a.path}`),
        })),
      });
      break;
    }

    case 'discover':
    case 'search': {
      const connector = connectorClient(flags.project);
      const q = args.join(' ') || flags.query || '';
      const matches = await connector.search(q, { limit: Number(flags.limit) || 20 });
      out({ matches: matches.map((m) => ({ tool: m.tool, risk: m.risk, description: m.description })) });
      break;
    }

    case 'show':
    case 'describe': {
      const connector = connectorClient(flags.project);
      const ref = args[0];
      if (!ref || !ref.includes('.')) throw new CliError('usage: kortix connectors show <connector>.<action>', 'USAGE');
      const tool = await connector.describe(ref);
      if (!tool) throw new CliError(`unknown tool "${ref}" — run 'kortix connectors discover' to list tools`, 'NOT_FOUND');
      out({ tool: tool.tool, risk: tool.risk, description: tool.description, inputSchema: tool.inputSchema });
      break;
    }

    case 'call': {
      const { slug, action, rawArgs } = parseConnectorCallInput(args, flags);
      const connector = connectorClient(flags.project);
      let parsed: Record<string, unknown> = {};
      if (rawArgs) {
        try { parsed = JSON.parse(rawArgs); } catch { throw new CliError('args must be valid JSON', 'BAD_ARGS'); }
      }
      // A gated call returns its authenticated approval URL immediately. The
      // server sends the decision back into the session after a human acts.
      const result = await callWithApprovalHandoff(connector, slug, action, parsed);
      out(result);
      break;
    }

    case 'add':
    case 'create': {
      // Add (or update) a connector on the project NOW — committed to
      // kortix.yaml on main + synced server-side, exactly like the dashboard's
      // "Add app". No change request needed; it's live this session. Then run
      // `kortix connectors connect <slug>` to surface the auth link.
      const slug = args[0];
      if (!slug) throw new CliError('usage: kortix connectors add <slug> --provider <p> [--app <app>] [--url <url>] …', 'USAGE');
      rejectBuiltinChannel(slug);
      const draft = connectorDraftFromFlags(slug, flags);
      const res = await addConnector(draft, flags.project);
      out({
        ok: true,
        slug,
        provider: draft.provider,
        applied: true,
        sync: res.sync,
        note: `Live now (committed to kortix.yaml on main + synced). Next: 'kortix connectors connect ${slug}' to get the auth link.`,
      });
      break;
    }

    case 'rm':
    case 'remove':
    case 'delete': {
      const slug = args[0];
      if (!slug) throw new CliError('usage: kortix connectors rm <slug>', 'USAGE');
      await removeConnector(slug, flags.project);
      out({ ok: true, slug, removed: true, note: 'Removed from kortix.yaml on main + catalog.' });
      break;
    }

    case 'connect': {
      // Mint a Pipedream Quick Connect link for a declared connector and hand
      // the URL to the human. SURFACE this url in your reply — in the web UI it
      // opens a 1-click connect popup; in Slack it's a tappable link. The agent
      // never touches the credential. The connector must already be declared in
      // kortix.yaml (add it + land the change request first).
      const slug = args[0];
      if (!slug) throw new CliError('usage: kortix connectors connect <connector-slug>', 'USAGE');
      rejectBuiltinChannel(slug);
      const expires = flags.expires ? Number(flags.expires) : undefined;
      const link = await mintConnectLink({ slug, expiresInMinutes: expires, projectOverride: flags.project });
      out({
        ok: true,
        slug: link.slug,
        app: link.app,
        url: link.url,
        expires_at: link.expires_at,
        note: 'Surface this url to the human. It opens Pipedream Quick Connect (web: popup, Slack: link). No keys touch the sandbox.',
      });
      break;
    }

    default:
      out({
        name: 'kortix connectors',
        description: 'One interface to every configured connector. Calls run server-side; no secrets in the sandbox.',
        commands: {
          ls: 'kortix connectors ls — list connectors + tools this session can use',
          discover: 'kortix connectors discover "<intent>" — search tools by natural language',
          show: 'kortix connectors show <connector>.<action> — show a tool\'s input schema',
          call: 'kortix connectors call <connector> <action> \'<json-args>\' — run a tool or return its approval link',
          add: 'kortix connectors add <slug> --provider pipedream --app <app> — add a connector NOW (no CR), then connect',
          rm: 'kortix connectors rm <slug> — remove a connector from the project',
          connect: 'kortix connectors connect <connector-slug> — mint a Pipedream Quick Connect link to hand the human',
          mcp: 'kortix connectors mcp — run the optional stdio MCP compatibility server',
        },
      });
  }
}

/** `argv` is everything after the `connectors` token. */
export async function runConnector(argv: string[]): Promise<number> {
  const { command, args, flags } = parseExecArgs(argv);

  // The MCP server owns stdin/stdout for JSON-RPC; run it directly.
  if (command === 'mcp') {
    return runConnectorMcpServer();
  }

  try {
    await dispatch(command, args, flags);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      out({ ok: false, error: err.message, code: 'CONNECTOR_ERROR' });
      return 1;
    }
    if (err instanceof CliError) {
      out({ ok: false, error: err.message, code: err.code });
      return err.exitCode;
    }
    out({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return 1;
  }
}
