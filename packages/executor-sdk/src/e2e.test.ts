/**
 * Live e2e for @kortix/executor-sdk — drives the REAL Executor gateway, no fakes.
 * The ultimate "does the published SDK actually work" check + a dogfood of the
 * channel connector path.
 *
 * Gated on env so CI/unit runs skip it. Provide a project that has a connector
 * (e.g. Slack connected) and run:
 *   KORTIX_API_URL=http://localhost:8008 \
 *   KORTIX_CLI_TOKEN=<token> \
 *   KORTIX_PROJECT_ID=<project> \
 *   bun test src/e2e.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { createExecutorClient, ExecutorError } from './index';

const apiUrl = process.env.KORTIX_API_URL;
const token = process.env.KORTIX_CLI_TOKEN ?? process.env.KORTIX_TOKEN;
const projectId = process.env.KORTIX_PROJECT_ID;
const ready = Boolean(apiUrl && token && projectId);

const client = ready ? createExecutorClient({ apiUrl: apiUrl!, token: token!, projectId }) : null;

describe.skipIf(!ready)('executor-sdk live e2e', () => {
  test('connectors() returns the project catalog', async () => {
    const conns = await client!.connectors();
    expect(Array.isArray(conns)).toBe(true);
    for (const c of conns) {
      expect(typeof c.slug).toBe('string');
      expect(Array.isArray(c.actions)).toBe(true);
    }
  });

  test('tools() flattens to <slug>.<action> ids', async () => {
    const tools = await client!.tools();
    for (const t of tools) expect(t.tool).toBe(`${t.connector}.${t.action}`);
  });

  // Slack-specific — only when a slack channel connector is present.
  test('slack.auth_test round-trips through the gateway (if slack connected)', async () => {
    const hasSlack = (await client!.connectors()).some((c) => c.slug === 'slack');
    if (!hasSlack) return; // project has no Slack connector — skip this assertion
    const res = await client!.call<{ ok: boolean; team?: string }>('slack', 'auth_test');
    expect(res.ok).toBe(true);
    expect((res.data as { ok?: boolean })?.ok).toBe(true);
  });

  test('a bad action surfaces an ExecutorError (not a silent ok)', async () => {
    const hasSlack = (await client!.connectors()).some((c) => c.slug === 'slack');
    if (!hasSlack) return;
    await expect(client!.call('slack', 'definitely_not_a_real_action')).rejects.toBeInstanceOf(ExecutorError);
  });
});
