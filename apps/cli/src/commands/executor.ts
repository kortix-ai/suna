/**
 * `kortix executor` — the agent's interface to every configured integration
 * (Pipedream / MCP / OpenAPI / GraphQL / HTTP), absorbed from the old in-sandbox
 * `executor` shim into the one kortix CLI.
 *
 * Three faces over ONE core (see ../executor/gateway.ts):
 *   - this CLI        (`kortix executor call …`, the agent's primary path)
 *   - the SDK         (`@kortix/executor-sdk`, durable TypeScript workflows)
 *   - the MCP server  (`kortix executor mcp`, optional compatibility face)
 *
 * Thin client: it never holds a third-party credential. Every tool call goes to
 * the Kortix Executor Gateway (/v1/executor/*), which checks sharing, resolves
 * the secret SERVER-SIDE, runs the call, and audits it. Auth comes from
 * KORTIX_EXECUTOR_TOKEN + KORTIX_API_URL, injected at sandbox spawn.
 *
 * MACHINE surface: emits JSON only (the agent parses stdout); index.ts skips the
 * host/update notices for `executor`.
 */
import { ExecutorError } from '@kortix/executor-sdk';
import {
  addConnector,
  executorClient,
  mintConnectLink,
  removeConnector,
} from '../executor/gateway.ts';
import { runExecutorMcpServer } from '../executor/mcp.ts';
import { CliError, out, parseExecArgs } from '../executor/io.ts';

const PROVIDERS = ['pipedream', 'mcp', 'openapi', 'graphql', 'http'];

// Build a connector draft (ConnectorDraft on the API) from CLI flags.
function connectorDraftFromFlags(slug: string, flags: Record<string, string | undefined>): Record<string, unknown> {
  const provider = flags.provider;
  if (!provider) throw new CliError('--provider is required (pipedream|mcp|openapi|graphql|http)', 'USAGE');
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
      const executor = executorClient(flags.project);
      const connectors = await executor.connectors();
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
      const executor = executorClient(flags.project);
      const q = args.join(' ') || flags.query || '';
      const matches = await executor.discover(q, { limit: Number(flags.limit) || 20 });
      out({ matches: matches.map((m) => ({ tool: m.tool, risk: m.risk, description: m.description })) });
      break;
    }

    case 'describe': {
      const executor = executorClient(flags.project);
      const ref = args[0];
      if (!ref || !ref.includes('.')) throw new CliError('usage: kortix executor describe <connector>.<action>', 'USAGE');
      const tool = await executor.describe(ref);
      if (!tool) throw new CliError(`unknown tool "${ref}" — run 'kortix executor discover' to list tools`, 'NOT_FOUND');
      out({ tool: tool.tool, risk: tool.risk, description: tool.description, inputSchema: tool.inputSchema });
      break;
    }

    case 'call': {
      const executor = executorClient(flags.project);
      const slug = args[0];
      const action = args[1];
      if (!slug || !action) throw new CliError('usage: kortix executor call <connector> <action> [json-args]', 'USAGE');
      const raw = args[2] ?? flags.args;
      let parsed: Record<string, unknown> = {};
      if (raw) {
        try { parsed = JSON.parse(raw); } catch { throw new CliError('args must be valid JSON', 'BAD_ARGS'); }
      }
      const result = await executor.call(slug, action, parsed);
      out(result);
      break;
    }

    case 'add':
    case 'create': {
      // Add (or update) a connector on the project NOW — committed to
      // kortix.toml on main + synced server-side, exactly like the dashboard's
      // "Add app". No change request needed; it's live this session. Then run
      // `kortix executor connect <slug>` to surface the auth link.
      const slug = args[0];
      if (!slug) throw new CliError('usage: kortix executor add <slug> --provider <p> [--app <app>] [--url <url>] …', 'USAGE');
      const draft = connectorDraftFromFlags(slug, flags);
      const res = await addConnector(draft, flags.project);
      out({
        ok: true,
        slug,
        provider: draft.provider,
        applied: true,
        sync: res.sync,
        note: `Live now (committed to kortix.toml on main + synced). Next: 'kortix executor connect ${slug}' to get the auth link.`,
      });
      break;
    }

    case 'rm':
    case 'remove':
    case 'delete': {
      const slug = args[0];
      if (!slug) throw new CliError('usage: kortix executor rm <slug>', 'USAGE');
      await removeConnector(slug, flags.project);
      out({ ok: true, slug, removed: true, note: 'Removed from kortix.toml on main + catalog.' });
      break;
    }

    case 'connect': {
      // Mint a Pipedream Quick Connect link for a declared connector and hand
      // the URL to the human. SURFACE this url in your reply — in the web UI it
      // opens a 1-click connect popup; in Slack it's a tappable link. The agent
      // never touches the credential. The connector must already be declared in
      // kortix.toml (add it + land the change request first).
      const slug = args[0];
      if (!slug) throw new CliError('usage: kortix executor connect <connector-slug>', 'USAGE');
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
        name: 'kortix executor',
        description: 'One interface to every configured integration. Calls run server-side; no secrets in the sandbox.',
        commands: {
          connectors: 'kortix executor connectors — list connectors + tools this session can use',
          discover: 'kortix executor discover "<intent>" — search tools by natural language',
          describe: 'kortix executor describe <connector>.<action> — show a tool\'s input schema',
          call: 'kortix executor call <connector> <action> \'<json-args>\' — run a tool',
          add: 'kortix executor add <slug> --provider pipedream --app <app> — add a connector NOW (no CR), then connect',
          rm: 'kortix executor rm <slug> — remove a connector from the project',
          connect: 'kortix executor connect <connector-slug> — mint a Pipedream Quick Connect link to hand the human',
          mcp: 'kortix executor mcp — run the optional stdio MCP compatibility server',
        },
      });
  }
}

/** `argv` is everything AFTER the `executor` token. */
export async function runExecutor(argv: string[]): Promise<number> {
  const { command, args, flags } = parseExecArgs(argv);

  // The MCP server owns stdin/stdout for JSON-RPC; run it directly.
  if (command === 'mcp') {
    return runExecutorMcpServer();
  }

  try {
    await dispatch(command, args, flags);
    return 0;
  } catch (err) {
    if (err instanceof ExecutorError) {
      out({ ok: false, error: err.message, code: 'EXECUTOR_ERROR' });
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
