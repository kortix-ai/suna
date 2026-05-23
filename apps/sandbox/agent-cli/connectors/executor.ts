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
import { parseArgs, out, handleError, CliError, requireEnv, getEnv } from '../lib';

interface CatalogAction {
  path: string;
  name: string;
  description: string;
  risk: string;
  inputSchema: unknown;
}
interface CatalogConnector {
  slug: string;
  name: string;
  provider: string;
  status: string;
  actions: CatalogAction[];
}

function apiBase(): string {
  const url = getEnv('KORTIX_API_URL')?.trim();
  if (!url) throw new CliError('KORTIX_API_URL not set — the Executor gateway is unreachable.', 'MISSING_ENV');
  return url.replace(/\/$/, '');
}

async function gateway<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = requireEnv('KORTIX_EXECUTOR_TOKEN');
  const res = await fetch(`${apiBase()}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body && typeof body === 'object' ? body.reason || body.error || `HTTP ${res.status}` : `HTTP ${res.status}`;
    throw new CliError(String(msg), 'EXECUTOR_ERROR', 1);
  }
  return body as T;
}

async function loadCatalog(): Promise<CatalogConnector[]> {
  const r = await gateway<{ connectors: CatalogConnector[] }>('/v1/executor/connectors');
  return r.connectors ?? [];
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv);

  switch (command) {
    case 'connectors':
    case 'ls': {
      const connectors = await loadCatalog();
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
      const q = (args.join(' ') || flags.query || '').toLowerCase();
      const connectors = await loadCatalog();
      const matches: Array<{ tool: string; risk: string; description: string }> = [];
      for (const c of connectors) {
        for (const a of c.actions) {
          const hay = `${c.slug}.${a.path} ${a.name} ${a.description}`.toLowerCase();
          if (!q || hay.includes(q)) {
            matches.push({ tool: `${c.slug}.${a.path}`, risk: a.risk, description: a.description });
          }
        }
      }
      out({ matches: matches.slice(0, Number(flags.limit) || 20) });
      break;
    }

    case 'describe': {
      const ref = args[0];
      if (!ref || !ref.includes('.')) throw new CliError('usage: executor describe <connector>.<action>', 'USAGE');
      const slug = ref.slice(0, ref.indexOf('.'));
      const action = ref.slice(ref.indexOf('.') + 1);
      const connectors = await loadCatalog();
      const c = connectors.find((x) => x.slug === slug);
      const a = c?.actions.find((x) => x.path === action);
      if (!a) throw new CliError(`unknown tool "${ref}" — run 'executor discover' to list tools`, 'NOT_FOUND');
      out({ tool: `${slug}.${a.path}`, risk: a.risk, description: a.description, inputSchema: a.inputSchema });
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
      const result = await gateway('/v1/executor/call', { method: 'POST', body: { connector: slug, action, args: parsed } });
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

main().catch(handleError);
