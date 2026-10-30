import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, gatewayRequestLogs, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { llmValueFields } from './llm-value';
import { totalSpendSql } from './llm-spend';
import { listProjectGatewaySourceSpend } from './session-costs';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const otherProjectId = crypto.randomUUID();
beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'LLM value test' });
  await db.insert(projects).values(
    [projectId, otherProjectId].map((id) => ({
      projectId: id,
      accountId,
      name: 'Synthetic',
      repoUrl: 'https://example.test/repo.git',
    })),
  );
});
afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

test('SQL values reconcile with sources; estimates never alter charges or duplicate across projects', async () => {
  const base = {
    accountId,
    projectId,
    requestedModel: 'codex/gpt-6.1-sol',
    resolvedModel: 'gpt-6.1-sol',
    provider: 'openai-codex',
    status: 200,
    ok: true,
    billingMode: 'none',
    inputTokens: 1000,
    outputTokens: 100,
    cachedTokens: 500,
  };
  await db.insert(gatewayRequestLogs).values([
    { ...base, requestId: crypto.randomUUID() },
    {
      ...base,
      requestId: crypto.randomUUID(),
      billingMode: 'credits',
      finalCost: '0.01',
    },
    { ...base, requestId: crypto.randomUUID(), resolvedModel: 'unknown' },
    {
      ...base,
      requestId: crypto.randomUUID(),
      metadata: { usageEstimated: true },
    },
    { ...base, requestId: crypto.randomUUID(), cachedTokens: 1001 },
    { ...base, requestId: crypto.randomUUID(), projectId: otherProjectId },
  ]);
  const [sum] = await db
    .select({ ...llmValueFields, actual: totalSpendSql })
    .from(gatewayRequestLogs)
    .where(eq(gatewayRequestLogs.projectId, projectId));
  expect(sum).toEqual({
    estimated_usage_value: 0.0041,
    priced_requests: 2,
    unpriced_requests: 3,
    actual: 0.01,
  });
  const report = await listProjectGatewaySourceSpend({
    accountId,
    projectId,
    hours: 24,
  });
  expect(report.sources).toHaveLength(1);
  expect(report.total.estimated_usage_value).toBeCloseTo(0.0041, 10);
  expect(report.sources[0]?.estimated_usage_value).toBe(report.total.estimated_usage_value);
  expect(report.total.cost).toBe(0.01);
  expect(report.total.priced_requests).toBe(2);
  expect(report.total.unpriced_requests).toBe(3);
  expect(report.valuation.subscription_fee).toBeNull();
  expect(report.valuation.subscription_allocation).toBeNull();
  const other = await listProjectGatewaySourceSpend({
    accountId,
    projectId: otherProjectId,
    hours: 24,
  });
  expect(other.total.estimated_usage_value).toBe(0.00205);
});

test('an unsupported-only window remains unknown, never a guessed zero', async () => {
  const id = crypto.randomUUID();
  await db.insert(projects).values({
    projectId: id,
    accountId,
    name: 'Unknown rates',
    repoUrl: 'https://example.test/unknown.git',
  });
  await db.insert(gatewayRequestLogs).values({
    requestId: crypto.randomUUID(),
    accountId,
    projectId: id,
    requestedModel: 'unknown',
    resolvedModel: 'unknown',
    provider: 'unknown',
    status: 200,
    ok: true,
  });
  const report = await listProjectGatewaySourceSpend({
    accountId,
    projectId: id,
    hours: 24,
  });
  expect(report.total.estimated_usage_value).toBeNull();
  expect(report.total.unpriced_requests).toBe(1);
});
