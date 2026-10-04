/**
 * CHARACTERIZATION: a web-route decision updates the approval card that is
 * still live in a chat thread.
 *
 * `decideConnectorApproval` (projects/lib) ends by relaying the outcome to
 * `services/channels/approval-card-relay` — the one up-edge the dedupe inverts into a
 * caller-owned notification. This pin exercises the decision through the real
 * POST /approvals/:executionId route with a real database, and asserts the
 * card the decision leaves behind: exactly one updateBlocks call for the
 * recorded card location, with the outcome blocks. It must stay green before
 * and after the inversion.
 *
 * Real: the connector_calls row, the project, the owner's role, the decision.
 * Faked: Slack's HTTP surface (slack-api), the install token, and Supabase
 * JWT verification — this lane has no reachable GoTrue, and five repo test
 * files replace the same module (see http/middleware/auth.ts's comment).
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { accountMembers, connectorCalls } from '@kortix/db';
import { eq } from 'drizzle-orm';
import * as realSlackApi from '../services/channels/slack-api';
import * as realInstallStore from '../services/channels/install-store';
import { db } from '../lib/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const updated: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];

mock.module('../services/channels/slack-api', () => ({
  ...realSlackApi,
  updateBlocks: async (_t: string, channel: string, ts: string, text: string, blocks: unknown[]) => {
    updated.push({ channel, ts, text, blocks });
    return true;
  },
}));
mock.module('../services/channels/install-store', () => ({
  ...realInstallStore,
  loadSlackTokenForProject: async () => 'xoxb-test',
}));
mock.module('../services/auth/jwt-verify', () => ({
  // One synthetic Supabase session for the project owner. The decision's
  // caller, not the JWT machinery, is the subject here.
  verifySupabaseJwt: async (token: string) =>
    token === 'relay-owner-session'
      ? { ok: true, userId: OWNER, email: 'relay-owner@example.test', payload: {} }
      : { ok: false, reason: 'invalid-signature' },
  decodeSupabaseJwtPayload: () => null,
}));

const { app } = await import('../app/index');

const TEAM = 'T0RELAYTEST';
const CHANNEL = 'C0RELAYTEST';
const execIds: string[] = [];
let project: SeededProject;

async function pendingWithCard(): Promise<string> {
  const [row] = await db
    .insert(connectorCalls)
    .values({
      accountId: project.account_id,
      projectId: project.project_id,
      actionPath: 'gmail.send_draft',
      actingUserId: OWNER,
      sessionId: null,
      status: 'pending_approval',
      risk: 'write',
      resultSummary: {
        args_preview: { draft_id: 'r-1' },
        args_preview_complete: true,
        chat_card: { platform: 'slack', team_id: TEAM, channel: CHANNEL, ts: '200.0001' },
      },
    })
    .returning({ id: connectorCalls.executionId });
  execIds.push(row!.id);
  return row!.id;
}

/** The relay is fire-and-forget: poll for its one update instead of racing it. */
async function waitForCardUpdate(): Promise<void> {
  for (let i = 0; i < 40 && updated.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  project = await seedProject('approval-card-relay');
  await insertIntoView(db, accountMembers, {
    userId: OWNER,
    accountId: project.account_id,
    accountRole: 'owner',
  });
}, 20_000);

afterAll(async () => {
  if (project) {
    for (const id of execIds)
      await db.delete(connectorCalls).where(eq(connectorCalls.executionId, id));
    await removeSeeded([project]);
  }
});

test('a web-route decision replaces the chat card with the outcome', async () => {
  const executionId = await pendingWithCard();
  const response = await app.request(`/v1/projects/${project.project_id}/approvals/${executionId}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer relay-owner-session', 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'deny', note: 'not this recipient' }),
  });
  expect(response.status).toBe(200);

  await waitForCardUpdate();
  expect(updated).toHaveLength(1);
  expect(updated[0]).toMatchObject({ channel: CHANNEL, ts: '200.0001' });
  expect(updated[0]!.text).toBe('Denied: gmail.send_draft');
  expect(JSON.stringify(updated[0]!.blocks)).toContain('not this recipient');
});
