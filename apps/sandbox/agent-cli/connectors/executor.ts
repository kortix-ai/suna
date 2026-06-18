#!/usr/bin/env bun
/**
 * executor — the agent's single interface to every configured integration
 * (Pipedream / MCP / OpenAPI / GraphQL / HTTP). Thin client: it never holds a
 * third-party credential. Every call goes to the Kortix Executor Gateway
 * (/v1/executor/*), which checks this user's connector sharing, resolves the
 * secret SERVER-SIDE, runs the call, and audits it.
 *
 * Auth: KORTIX_EXECUTOR_TOKEN (acts as the launching user) + KORTIX_API_URL,
 * both injected at sandbox spawn. See docs/specs/executor.md.
 *
 * Usage:
 *   executor connectors                       # what this session can use
 *   executor discover "send a slack message"  # intent search across tools
 *   executor describe stripe.charges.create   # full input schema for one tool
 *   executor call stripe charges.create '{"amount":999,"currency":"usd"}'
 */
import { createExecutorClient, ExecutorError } from '../../../../packages/executor-sdk/src/index';
import { parseArgs, out, handleError, CliError, requireEnv, getEnv, mintConnectLink, kortixPost, kortixDelete, kortixProjectId } from '../lib';

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

function requireProjectId(): string {
  const id = kortixProjectId();
  if (!id) throw new CliError('KORTIX_PROJECT_ID not set', 'MISSING_ENV');
  return id;
}

function apiBase(): string {
  const url = getEnv('KORTIX_API_URL')?.trim();
  if (!url) throw new CliError('KORTIX_API_URL not set — the Executor gateway is unreachable.', 'MISSING_ENV');
  return url.replace(/\/$/, '');
}

function client() {
  return createExecutorClient({
    apiUrl: apiBase(),
    token: requireEnv('KORTIX_EXECUTOR_TOKEN'),
  });
}

export async function main(argv = process.argv): Promise<void> {
  const { command, args, flags } = parseArgs(argv);
  const executor = client();

  switch (command) {
    case 'connectors':
    case 'ls': {
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
      const q = args.join(' ') || flags.query || '';
      const matches = await executor.discover(q, { limit: Number(flags.limit) || 20 });
      out({ matches: matches.map((m) => ({ tool: m.tool, risk: m.risk, description: m.description })) });
      break;
    }

    case 'describe': {
      const ref = args[0];
      if (!ref || !ref.includes('.')) throw new CliError('usage: executor describe <connector>.<action>', 'USAGE');
      const tool = await executor.describe(ref);
      if (!tool) throw new CliError(`unknown tool "${ref}" — run 'executor discover' to list tools`, 'NOT_FOUND');
      out({ tool: tool.tool, risk: tool.risk, description: tool.description, inputSchema: tool.inputSchema });
      break;
    }

    case 'call': {
      const slug = args[0];
      const action = args[1];
      if (!slug || !action) throw new CliError('usage: executor call <connector> <action> [json-args]', 'USAGE');
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
      // `executor connect <slug>` to surface the auth link.
      const slug = args[0];
      if (!slug) throw new CliError('usage: executor add <slug> --provider <p> [--app <app>] [--url <url>] …', 'USAGE');
      const draft = connectorDraftFromFlags(slug, flags);
      const res = await kortixPost<{ ok: boolean; sync?: unknown }>(
        `/executor/projects/${requireProjectId()}/connectors`,
        draft,
      );
      out({
        ok: true,
        slug,
        provider: draft.provider,
        applied: true,
        sync: res.sync,
        note: `Live now (committed to kortix.toml on main + synced). Next: 'executor connect ${slug}' to get the auth link.`,
      });
      break;
    }

    case 'rm':
    case 'remove':
    case 'delete': {
      const slug = args[0];
      if (!slug) throw new CliError('usage: executor rm <slug>', 'USAGE');
      await kortixDelete(`/executor/projects/${requireProjectId()}/connectors/${encodeURIComponent(slug)}`);
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
      if (!slug) throw new CliError('usage: executor connect <connector-slug>', 'USAGE');
      const expires = flags.expires ? Number(flags.expires) : undefined;
      const link = await mintConnectLink({ slug, expiresInMinutes: expires });
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
        name: 'executor',
        description: 'One interface to every configured integration. Calls run server-side; no secrets in the sandbox.',
        commands: {
          connectors: 'executor connectors — list connectors + tools this session can use',
          discover: 'executor discover "<intent>" — search tools by natural language',
          describe: 'executor describe <connector>.<action> — show a tool\'s input schema',
          call: 'executor call <connector> <action> \'<json-args>\' — run a tool',
          add: 'executor add <slug> --provider pipedream --app <app> — add a connector NOW (no CR), then connect',
          rm: 'executor rm <slug> — remove a connector from the project',
          connect: 'executor connect <connector-slug> — mint a Pipedream Quick Connect link to hand the human',
        },
      });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof ExecutorError) {
      handleError(new CliError(err.message, 'EXECUTOR_ERROR', 1));
    }
    handleError(err);
  });
}
