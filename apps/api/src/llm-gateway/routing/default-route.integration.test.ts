/**
 * Integration test (real local DB): the project's Routing chain reaches a
 * session that requests a configured default, whatever default the gateway
 * resolved for its principal.
 *
 * Incident 2026-10-02: a trigger pinned to the project default ran on an agent
 * with its own default. The route was `direct`, so a ChatGPT usage-limit 429
 * reached the session and the chain never ran.
 *
 * Every row is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountModelPreferences,
  accounts,
  projectLlmRoutingPolicies,
  projectSessions,
  projects,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { db } from '../../shared/db';
import { resolveGatewayRoute } from './index';

const tag = crypto.randomUUID().slice(0, 8);
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const SESSION = `route-${tag}`;

const PROJECT_DEFAULT = 'codex/project-default';
const AGENT_DEFAULT = 'codex/agent-default';
const CHAIN = ['chain-first', 'chain-second'];

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role) values
      (${OWNER}::uuid, ${`owner-${tag}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  `);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: `default-route-${tag}` });
  await db.insert(projects).values({
    projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git',
  });
  await db.insert(projectSessions).values({
    sessionId: SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: SESSION,
    createdBy: OWNER, agentName: 'engineering',
  });
  await db.insert(accountModelPreferences).values([
    { accountId: ACCOUNT, scope: 'project', scopeKey: PROJECT, model: PROJECT_DEFAULT },
    { accountId: ACCOUNT, scope: 'agent', scopeKey: 'engineering', projectId: PROJECT, model: AGENT_DEFAULT },
  ]);
  await db.insert(projectLlmRoutingPolicies).values({
    projectId: PROJECT, defaultFallbackModels: CHAIN, defaultFallbackOn: 'any-error',
  });
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades project, session, preferences, policy
  await db.execute(sql`delete from auth.users where id = ${OWNER}::uuid`);
});

describe('resolveGatewayRoute — the project chain follows the configured defaults', () => {
  // The principal as authentication builds it for a session on `engineering`:
  // its default is the agent's.
  const session = { userId: OWNER, accountId: ACCOUNT, projectId: PROJECT, sessionId: SESSION, defaultModel: AGENT_DEFAULT };
  const route = (principal: typeof session | Omit<typeof session, 'defaultModel'>, requestedModel: string) =>
    resolveGatewayRoute(principal, { requestedModel, requires: { imageInput: false } });

  test('a request for the project default takes the chain on an agent with its own default', async () => {
    expect(await route(session, PROJECT_DEFAULT)).toMatchObject({
      policyId: 'project:default',
      primaryModel: PROJECT_DEFAULT,
      fallbackModels: CHAIN,
      fallbackOn: 'any-error',
    });
  });

  test('the agent default still takes the chain', async () => {
    expect(await route(session, AGENT_DEFAULT)).toMatchObject({ policyId: 'project:default', fallbackModels: CHAIN });
  });

  test('a default dropped at authentication as unservable still takes the chain', async () => {
    // Every ChatGPT account paused: authentication attaches no default.
    const { defaultModel: _dropped, ...paused } = session;
    expect(await route(paused, PROJECT_DEFAULT)).toMatchObject({ policyId: 'project:default', fallbackModels: CHAIN });
    expect(await route(paused, AGENT_DEFAULT)).toMatchObject({ policyId: 'project:default', fallbackModels: CHAIN });
  });

  test('a model that is no default stays direct', async () => {
    expect(await route(session, 'codex/another-model')).toMatchObject({ policyId: 'direct', fallbackModels: [] });
  });
});
