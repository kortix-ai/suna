import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The Convex edge, faked: count memberToken calls and control their answer.
const calls: string[] = [];
let answer: () => Promise<unknown> = async () => ({});
let jwt = 'jwt-alice';
mock.module('../../src/server/auth-server', () => ({
  getToken: async () => jwt,
  fetchAuthAction: async (_ref: unknown, args: { matterId: string }) => {
    calls.push(args.matterId);
    await new Promise((r) => setTimeout(r, 5));
    return answer();
  },
  fetchAuthMutation: async () => null,
  fetchAuthQuery: async (_ref: unknown, args: { kortixSessionId: string }) => threadMatter.get(args.kortixSessionId) ?? null,
}));
const threadMatter = new Map<string, { matterId: string }>();
const { resolveMember, resolveMemberForSession } = await import('../../src/server/member');

const MATTER = 'k57abcdefghijklmnopqrstuvwxyz0123';
const req = (m = MATTER) => new Request('http://lumen.test/api/kortix/x', { headers: { authorization: `Bearer matter.${m}` } });
const minted = (expiresAt: number) => ({ token: 'kortix_pat_1', projectId: 'proj_1', expiresAt, userId: 'u1', orgId: 'o1', firmId: 'f1' });

let n = 0;
beforeEach(() => {
  calls.length = 0;
  process.env.LUMEN_PROXY_SECRET = 'secret';
  // A fresh JWT per test, so the module cache of an earlier test does not answer.
  jwt = `jwt-${++n}`;
});

describe('resolveMember: one Convex call per (user, matter) at a time', () => {
  test('10 concurrent calls share one memberToken call', async () => {
    answer = async () => minted(Date.now() + 3_600_000);
    const out = await Promise.all(Array.from({ length: 10 }, () => resolveMember(req())));
    expect(calls).toHaveLength(1);
    for (const r of out) expect('member' in r && r.member.token).toBe('kortix_pat_1');
  });

  test('a cached member is reused for 60 s, then re-checked', async () => {
    answer = async () => minted(Date.now() + 3_600_000);
    await resolveMember(req());
    await resolveMember(req());
    expect(calls).toHaveLength(1);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      await resolveMember(req());
    } finally {
      Date.now = realNow;
    }
    expect(calls).toHaveLength(2);
  });

  test('a token that expires within a minute is not cached', async () => {
    answer = async () => minted(Date.now() + 30_000);
    await resolveMember(req());
    await resolveMember(req());
    expect(calls).toHaveLength(2);
  });

  test('a shared refusal gives every concurrent caller its own readable body and status', async () => {
    answer = async () => {
      throw new Error('[CONVEX A(kortix:memberToken)] Uncaught Error: 403: not a member of this firm');
    };
    const out = await Promise.all(Array.from({ length: 3 }, () => resolveMember(req())));
    expect(calls).toHaveLength(1);
    for (const r of out) {
      if (!('error' in r)) throw new Error('expected a refusal');
      expect(r.error.status).toBe(403);
      expect(await r.error.json()).toEqual({ error: 'Matter access denied' });
    }
  });

  test('a provisioning firm is a 409; a missing bearer, a 400', async () => {
    answer = async () => {
      throw new Error('Uncaught Error: 409: the firm workspace is still being set up');
    };
    const r = await resolveMember(req());
    expect('error' in r && r.error.status).toBe(409);
    const bad = await resolveMember(new Request('http://lumen.test/x'));
    expect('error' in bad && bad.error.status).toBe(400);
  });
});

describe('resolveMemberForSession: the side routes (session-model, preview-url) check the matter like the proxy', () => {
  const OWN = '0b8c9d3e-1111-4222-8333-944455556666';
  const OTHER = '7a1b2c3d-1111-4222-8333-944455556666';
  test('a session of the bearer matter resolves; a session of another matter or no thread is 404', async () => {
    answer = async () => minted(Date.now() + 3_600_000);
    threadMatter.set(OWN, { matterId: MATTER });
    threadMatter.set(OTHER, { matterId: 'k57someothermatter00000000000000' });
    const own = await resolveMemberForSession(req(), 'proj_1', OWN);
    expect('member' in own).toBe(true);
    for (const sid of [OTHER, '11111111-1111-4111-8111-111111111111']) {
      const r = await resolveMemberForSession(req(), 'proj_1', sid);
      expect('error' in r && r.error.status).toBe(404);
    }
    const wrongProject = await resolveMemberForSession(req(), 'proj_2', OWN);
    expect('error' in wrongProject && wrongProject.error.status).toBe(404);
  });
});
