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
import { parseArgs, out, handleError, CliError, requireEnv, getEnv } from '../lib';

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

    default:
      out({
        name: 'executor',
        description: 'One interface to every configured integration. Calls run server-side; no secrets in the sandbox.',
        commands: {
          connectors: 'executor connectors — list connectors + tools this session can use',
          discover: 'executor discover "<intent>" — search tools by natural language',
          describe: 'executor describe <connector>.<action> — show a tool\'s input schema',
          call: 'executor call <connector> <action> \'<json-args>\' — run a tool',
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
