/**
 * Integration test (real local DB) for join-links.ts — the short, ungessable
 * `voice_spawn` join link that replaced embedding a ~300-char LiveKit JWT
 * directly in a URL. `voice_join_links` has no FK to projects/sessions (see
 * the migration's expand/contract checklist), so this needs no seeded
 * project row — synthetic ids are enough.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { voiceCallTurns, voiceJoinLinks } from '@kortix/db';
import { db } from '../shared/db';
import { looksLikeJoinLinkToken, mintJoinLink, resolveJoinLink, revokeJoinLinksForCall } from '../channels/voice/join-links';
import { voiceJoinPublicApp } from '../channels/voice/public-join-routes';

const mintedCallIds: string[] = [];

function callId(): string {
  const id = `voice-join-link-test-${crypto.randomUUID()}`;
  mintedCallIds.push(id);
  return id;
}

afterAll(async () => {
  for (const id of mintedCallIds) {
    await db.delete(voiceJoinLinks).where(eq(voiceJoinLinks.callId, id));
    await db.delete(voiceCallTurns).where(eq(voiceCallTurns.callId, id));
  }
});

describe('mintJoinLink / resolveJoinLink', () => {
  test('mints a token that looks like our scheme and resolves back to the same call', async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    const { token, expiresAt } = await mintJoinLink({ callId: id, projectId });

    expect(looksLikeJoinLinkToken(token)).toBe(true);
    expect(token.length).toBeGreaterThan(30);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const resolved = await resolveJoinLink(token);
    expect(resolved).toEqual({ ok: true, callId: id, projectId });
  });

  test('two links minted for the same call are independently resolvable and independently random', async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    const a = await mintJoinLink({ callId: id, projectId });
    const b = await mintJoinLink({ callId: id, projectId });

    expect(a.token).not.toBe(b.token);
    expect(await resolveJoinLink(a.token)).toEqual({ ok: true, callId: id, projectId });
    expect(await resolveJoinLink(b.token)).toEqual({ ok: true, callId: id, projectId });
  });

  test('an unknown token 404s without a DB round trip leaking which reason', async () => {
    const resolved = await resolveJoinLink('vjl_this-was-never-minted');
    expect(resolved).toEqual({ ok: false, status: 404, error: 'Invalid or unknown link' });
  });

  test('a token missing the scheme prefix is rejected as unknown, never looked up', async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    const { token } = await mintJoinLink({ callId: id, projectId });
    const withoutPrefix = token.replace(/^vjl_/, '');

    const resolved = await resolveJoinLink(withoutPrefix);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.status).toBe(404);
  });

  test('null/empty/undefined tokens are unknown, not a crash', async () => {
    expect((await resolveJoinLink(null)).ok).toBe(false);
    expect((await resolveJoinLink(undefined)).ok).toBe(false);
    expect((await resolveJoinLink('')).ok).toBe(false);
  });

  test('an expired link 410s instead of resolving', async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    const { token } = await mintJoinLink({ callId: id, projectId, ttlSeconds: -1 });

    const resolved = await resolveJoinLink(token);
    expect(resolved).toEqual({ ok: false, status: 410, error: 'This link has expired' });
  });
});

describe('revokeJoinLinksForCall', () => {
  test('revokes every link for a call — a resolve afterwards 410s', async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    const a = await mintJoinLink({ callId: id, projectId });
    const b = await mintJoinLink({ callId: id, projectId });

    await revokeJoinLinksForCall(id);

    expect(await resolveJoinLink(a.token)).toEqual({ ok: false, status: 410, error: 'This call has ended' });
    expect(await resolveJoinLink(b.token)).toEqual({ ok: false, status: 410, error: 'This call has ended' });
  });

  test('never touches links for a different call', async () => {
    const endedCallId = callId();
    const liveCallId = callId();
    const projectId = crypto.randomUUID();
    const ended = await mintJoinLink({ callId: endedCallId, projectId });
    const live = await mintJoinLink({ callId: liveCallId, projectId });

    await revokeJoinLinksForCall(endedCallId);

    expect((await resolveJoinLink(ended.token)).ok).toBe(false);
    expect(await resolveJoinLink(live.token)).toEqual({ ok: true, callId: liveCallId, projectId });
  });

  test('is idempotent — revoking an already-revoked call does not throw', async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    await mintJoinLink({ callId: id, projectId });

    await revokeJoinLinksForCall(id);
    await expect(revokeJoinLinksForCall(id)).resolves.toBeUndefined();
  });
});

describe('looksLikeJoinLinkToken', () => {
  test('true only for our prefix — used to route legacy raw-JWT links without a DB round trip', () => {
    expect(looksLikeJoinLinkToken('vjl_abc123')).toBe(true);
    expect(looksLikeJoinLinkToken('eyJhbGciOiJIUzI1NiJ9.raw.jwt')).toBe(false);
    expect(looksLikeJoinLinkToken('')).toBe(false);
  });
});

/**
 * `GET /v1/public/voice-join/:token/transcript` against the real route and the
 * real table — the endpoint the /voice page reads its transcript from.
 *
 * Two things on trial, and the second is the one that bites:
 *
 *  1. The WHOLE record comes back, `speaker` included. The Kortix agent's own
 *     lines and the voice's own speech are both `role: 'agent'`, so `speaker`
 *     is the only thing that tells them apart, and a tool call is meaningless
 *     without the tool's name. Dropping that column is exactly what left the
 *     page unable to show who said what.
 *  2. It is scoped by the JOIN LINK and nothing else. The caller names a
 *     token; the token names the call. No call, session or project id appears
 *     anywhere in the request, so there is nothing for an anonymous visitor to
 *     swap for someone else's — and a revoked link stops reading the
 *     transcript on the same terms it stops minting LiveKit tokens.
 */
describe('GET /public/voice-join/:token/transcript', () => {
  async function seedTurns(
    id: string,
    projectId: string,
    turns: Array<{ role: string; speaker: string | null; text: string }>,
  ): Promise<void> {
    for (const turn of turns) {
      await db.insert(voiceCallTurns).values({
        callId: id,
        projectId,
        sessionId: id,
        role: turn.role,
        speaker: turn.speaker,
        text: turn.text,
      });
    }
  }

  async function get(path: string): Promise<{ status: number; body: any }> {
    const res = await voiceJoinPublicApp.request(`http://local${path}`);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  test('returns every kind of turn — both voices, the Kortix agent, and the tool calls', async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    const { token } = await mintJoinLink({ callId: id, projectId });
    await seedTurns(id, projectId, [
      { role: 'user', speaker: null, text: 'is the deploy done?' },
      { role: 'tool', speaker: 'ask_kortix', text: 'ask_kortix: is the deploy done?' },
      { role: 'tool', speaker: 'run_command', text: 'run_command: git log -1 → ok' },
      { role: 'agent', speaker: 'kortix', text: 'The deploy finished.' },
      { role: 'agent', speaker: 'Kortix Voice', text: 'Yep, it just finished!' },
    ]);

    const { status, body } = await get(`/${token}/transcript`);
    expect(status).toBe(200);
    expect(body.call_id).toBe(id);
    // `speaker` is load-bearing: without it the Kortix agent's line and the
    // voice's line are both just "agent", and a tool row has no tool.
    expect(body.turns.map((t: any) => [t.role, t.speaker, t.text])).toEqual([
      ['user', null, 'is the deploy done?'],
      ['tool', 'ask_kortix', 'ask_kortix: is the deploy done?'],
      ['tool', 'run_command', 'run_command: git log -1 → ok'],
      ['agent', 'kortix', 'The deploy finished.'],
      ['agent', 'Kortix Voice', 'Yep, it just finished!'],
    ]);
  });

  test('the cursor advances and pages the rest — an idle poll returns nothing and holds position', async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    const { token } = await mintJoinLink({ callId: id, projectId });
    await seedTurns(id, projectId, [
      { role: 'user', speaker: null, text: 'first' },
      { role: 'agent', speaker: 'kortix', text: 'second' },
    ]);

    const first = await get(`/${token}/transcript`);
    expect(first.body.turns).toHaveLength(2);

    const idle = await get(`/${token}/transcript?cursor=${first.body.cursor}`);
    expect(idle.body.turns).toEqual([]);
    expect(idle.body.cursor).toBe(first.body.cursor);

    await seedTurns(id, projectId, [{ role: 'agent', speaker: 'Kortix Voice', text: 'third' }]);
    const next = await get(`/${token}/transcript?cursor=${first.body.cursor}`);
    expect(next.body.turns.map((t: any) => t.text)).toEqual(['third']);
    expect(next.body.cursor).toBeGreaterThan(first.body.cursor);
  });

  test('reads ONLY the call its own link was minted for', async () => {
    const mine = callId();
    const theirs = callId();
    const projectId = crypto.randomUUID();
    const { token } = await mintJoinLink({ callId: mine, projectId });
    await seedTurns(mine, projectId, [{ role: 'user', speaker: null, text: 'mine' }]);
    // Same project, different call — a visitor holding one call's link must
    // not see the other, and has no id in the request to reach it with.
    await seedTurns(theirs, projectId, [{ role: 'user', speaker: null, text: 'theirs' }]);

    const { body } = await get(`/${token}/transcript`);
    expect(body.turns.map((t: any) => t.text)).toEqual(['mine']);
  });

  test("never echoes the link's project id back to an anonymous caller", async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    const { token } = await mintJoinLink({ callId: id, projectId });
    await seedTurns(id, projectId, [{ role: 'user', speaker: null, text: 'hello' }]);

    const { body } = await get(`/${token}/transcript`);
    expect(JSON.stringify(body)).not.toContain(projectId);
  });

  test('an unknown token 404s', async () => {
    const { status, body } = await get('/vjl_this-was-never-minted/transcript');
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Invalid or unknown link' });
  });

  test('a revoked link 410s — ending the call ends the transcript with it', async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    const { token } = await mintJoinLink({ callId: id, projectId });
    await seedTurns(id, projectId, [{ role: 'user', speaker: null, text: 'hello' }]);

    expect((await get(`/${token}/transcript`)).status).toBe(200);
    await revokeJoinLinksForCall(id);

    const { status, body } = await get(`/${token}/transcript`);
    expect(status).toBe(410);
    expect(body).toEqual({ error: 'This call has ended' });
  });

  test('an expired link 410s', async () => {
    const id = callId();
    const projectId = crypto.randomUUID();
    const { token } = await mintJoinLink({ callId: id, projectId, ttlSeconds: -1 });

    const { status } = await get(`/${token}/transcript`);
    expect(status).toBe(410);
  });

  test('polling has its own rate-limit budget — 40 reads in a row all succeed', async () => {
    // The resolve step's limiter allows 30/min. Sharing it would rate-limit a
    // single honest listener polling its own call against itself.
    const id = callId();
    const projectId = crypto.randomUUID();
    const { token } = await mintJoinLink({ callId: id, projectId });

    for (let i = 0; i < 40; i++) {
      expect((await get(`/${token}/transcript`)).status).toBe(200);
    }
  });
});
