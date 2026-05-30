#!/usr/bin/env bun
/**
 * LIVE end-to-end test of the Executor MCP server against the running API.
 *
 *   seed a no-auth httpbin connector on a real project
 *   → mint a real project-scoped executor token
 *   → spawn the REAL executor-mcp stdio server pointed at the LIVE gateway
 *   → drive initialize → tools/list → connectors → discover → describe → call
 *   → assert the call made a real outbound request (httpbin echo)
 *   → assert an audit row was written to the live DB
 *
 * Run from apps/api/ (so Bun loads apps/api/.env) with the API up on :8008.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { executorConnectors, executorConnectorActions, executorExecutions } from '@kortix/db';
import { createAccountToken } from '../repositories/account-tokens';

const API_URL = process.env.LIVE_API_URL ?? 'http://localhost:8008/v1';
const PROJECT_ID = process.env.LIVE_PROJECT_ID ?? '0e96d960-42ff-4f71-a65a-7026848c1d1d';
const SLUG = 'httpbin-live';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const EXECUTOR_MCP = resolve(REPO_ROOT, 'apps/sandbox/agent-cli/connectors/executor-mcp.ts');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function seed(): Promise<string> {
  const [proj] = await db.execute<{ account_id: string }>(
    sql`select account_id from kortix.projects where project_id = ${PROJECT_ID} limit 1`,
  ).then((r) => ((r as any).rows ?? r) as { account_id: string }[]);
  if (!proj) throw new Error(`project ${PROJECT_ID} not found`);
  const accountId = proj.account_id;

  await db.delete(executorConnectors).where(
    and(eq(executorConnectors.projectId, PROJECT_ID), eq(executorConnectors.slug, SLUG)),
  );
  const [conn] = await db.insert(executorConnectors).values({
    accountId, projectId: PROJECT_ID, slug: SLUG, name: 'HTTPBin (live e2e)',
    providerType: 'http', enabled: true,
    config: { baseUrl: 'https://httpbin.org', auth: { type: 'none' } },
    shareScope: 'project', credentialMode: 'shared', status: 'active',
  }).returning();
  await db.insert(executorConnectorActions).values({
    connectorId: conn.connectorId, path: 'get', name: 'httpbin-live.get',
    description: 'GET https://httpbin.org/get — echoes query args back',
    inputSchema: { type: 'object', properties: { q: { type: 'string', 'x-in': 'query' } } },
    risk: 'read', binding: { kind: 'http', method: 'GET', path: '/get' },
  });

  const member = (await db.execute<{ user_id: string; account_id: string }>(
    sql`select user_id, account_id from kortix.account_members where account_id = ${accountId} order by joined_at limit 1`,
  ).then((r) => ((r as any).rows ?? r)))[0];
  if (!member) throw new Error(`no account_members for account ${accountId}`);

  const tok = await createAccountToken({
    accountId: member.account_id, userId: member.user_id, projectId: PROJECT_ID, name: 'executor-mcp-live-e2e',
  });
  return tok.secretKey;
}

async function driveMcp(token: string) {
  const proc = Bun.spawn({
    cmd: ['bun', EXECUTOR_MCP],
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, KORTIX_API_URL: API_URL, KORTIX_EXECUTOR_TOKEN: token },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  async function rpc(id: number, method: string, params?: unknown) {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    while (!buf.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('MCP closed early');
      buf += decoder.decode(value);
    }
    const nl = buf.indexOf('\n');
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const json = JSON.parse(line);
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  }
  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
    check('initialize → serverInfo kortix-executor', init?.serverInfo?.name === 'kortix-executor', init?.serverInfo);

    const listed = await rpc(2, 'tools/list');
    const names = (listed.tools ?? []).map((t: { name: string }) => t.name);
    check('tools/list → 4 stable meta-tools', JSON.stringify(names) === JSON.stringify(['connectors', 'discover', 'describe', 'call']), names);

    const conns = JSON.parse((await rpc(3, 'tools/call', { name: 'connectors', arguments: {} })).content[0].text);
    const seen = (conns.connectors ?? []).find((c: { slug: string }) => c.slug === SLUG);
    check('connectors → httpbin-live present (live gateway catalog)', Boolean(seen), conns.connectors?.map((c: any) => c.slug));

    const disc = JSON.parse((await rpc(4, 'tools/call', { name: 'discover', arguments: { query: 'httpbin' } })).content[0].text);
    check('discover "httpbin" → finds httpbin-live.get', (disc.matches ?? []).some((m: { tool: string }) => m.tool === `${SLUG}.get`), disc.matches);

    const desc = JSON.parse((await rpc(5, 'tools/call', { name: 'describe', arguments: { tool: `${SLUG}.get` } })).content[0].text);
    check('describe → returns input schema + risk', desc.tool === `${SLUG}.get` && desc.risk === 'read' && desc.inputSchema?.type === 'object', desc);

    const callRes = await rpc(6, 'tools/call', { name: 'call', arguments: { connector: SLUG, action: 'get', args: { q: 'live-mcp-e2e' } } });
    const payload = JSON.parse(callRes.content[0].text);
    check('call → ok (not isError)', callRes.isError === false && payload.ok === true, payload);
    // httpbin echoes query args under .args; the gateway returns the parsed body in .data
    const echoedQ = payload?.data?.args?.q;
    check('call → REAL upstream hit (httpbin echoed q=live-mcp-e2e)', echoedQ === 'live-mcp-e2e', payload?.data);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

async function verifyAudit() {
  const [row] = await db
    .select()
    .from(executorExecutions)
    .where(and(eq(executorExecutions.projectId, PROJECT_ID), eq(executorExecutions.actionPath, `${SLUG}.get`)))
    .orderBy(desc(executorExecutions.createdAt))
    .limit(1);
  check('audit → execution row written (status=ok)', Boolean(row) && row.status === 'ok', row ? { status: row.status, actionPath: row.actionPath } : null);
}

async function main() {
  console.log(`\n🌐 LIVE MCP e2e — gateway ${API_URL}, project ${PROJECT_ID}\n`);
  const token = await seed();
  console.log('  • seeded httpbin-live connector + minted project-scoped token\n');
  await driveMcp(token);
  await verifyAudit();
  console.log(`\n${failed === 0 ? '✅ ALL LIVE CHECKS PASSED' : '❌ SOME CHECKS FAILED'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
