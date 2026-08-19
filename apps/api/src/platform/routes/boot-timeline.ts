/**
 * POST /v1/platform/boot-timeline — sandbox-only sink for the in-guest boot
 * timeline (apps/kortix-sandbox-agent-server/src/boot-timeline-relay.ts's
 * `relayBootTimelineToApi`), persisted via boot-timeline-store.ts's
 * `recordBootTimeline`.
 *
 * WIRING NOTES FOR THE CONNECTOR (both outside this file's scope):
 *   1. Mount this router in platform/index.ts:
 *        import { bootTimelineRouter } from './routes/boot-timeline';
 *        platformApp.route('/boot-timeline', bootTimelineRouter);
 *      (mirrors the existing `platformApp.route('/sandbox/version', versionRouter)`
 *      and `platformApp.route('/github-app', githubAppSetupRouter)` lines.)
 *   2. Add this route's path suffix to `sandboxTokenPathAllowed` in
 *      middleware/auth.ts's `supabaseAuth` — a sandbox (Kortix) token is only
 *      accepted on an explicit allowlist of path suffixes (currently
 *      `/git/clone-credential`, `/turn-stream`, `/turn-question`,
 *      `/llm-catalog`); without adding `/boot-timeline` there, every relay
 *      POST 401s before it reaches the handler below. That file is outside
 *      this change's file set, same reasoning as main.ts not being wired here.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { pinSandboxEgressIp, requestEgressIp } from '../services/sandbox-egress-pin';
import { db } from '../../shared/db';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import { recordBootTimeline } from '../services/boot-timeline-store';

const BootMarkSchema = z.object({ label: z.string(), atMs: z.number() });

const BootTimelineRequestSchema = z.object({
  session_id: z.string(),
  timeline: z.array(BootMarkSchema),
});

export const bootTimelineRouter = makeOpenApiApp<AppEnv>();

bootTimelineRouter.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['platform'],
    summary: 'Relay a sandbox in-guest boot timeline for server-side persistence',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: BootTimelineRequestSchema } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Timeline recorded'),
      ...errors(400, 403),
    },
  }),
  async (c) => {
    // Sandbox-only: this is the daemon relaying its OWN boot, never a user
    // action, so unlike turn-stream there is no PAT/dashboard fallback.
    const authType = c.get('authType');
    const apiKeyType = c.get('apiKeyType');
    if (authType !== 'apiKey' || apiKeyType !== 'sandbox') {
      return c.json({ error: 'boot-timeline requires a sandbox token' }, 403);
    }
    const accountId = c.get('accountId');
    const sandboxId = c.get('sandboxId');
    if (!accountId || !sandboxId) {
      return c.json({ error: 'boot-timeline requires a sandbox token' }, 403);
    }

    const body = c.req.valid('json');

    // Scope the token's own sandboxId back to the session it claims to be
    // relaying for (and to the caller's own account) — same defense-in-depth
    // as turn-stream's `authenticatedSandboxId` check, so a sandbox token can
    // only ever persist a timeline for the session it actually belongs to.
    const [sandbox] = await db
      .select({
        sessionId: sessionSandboxes.sessionId,
        provider: sessionSandboxes.provider,
      })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sandboxId, sandboxId),
          eq(sessionSandboxes.sessionId, body.session_id),
          eq(sessionSandboxes.accountId, accountId),
          inArray(sessionSandboxes.status, ['provisioning', 'active']),
        ),
      )
      .limit(1);
    if (!sandbox) {
      return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
    }

    // Pin the sandbox's egress address on the way past. THIS call is the right
    // moment: it is the daemon, authenticated with the SANDBOX credential, and
    // it happens before the agent can run — so the pin cannot be set by whoever
    // reaches the API first. Fire-and-forget for the same reason as the
    // timeline: a failed pin must never fail a boot.
    void pinSandboxEgressIp(sandboxId, requestEgressIp(c)).catch((err) =>
      console.warn('[egress-pin] could not pin sandbox egress ip (ignored):', err?.message ?? err),
    );

    // Fire-and-forget — this is telemetry, not a durability contract the
    // caller should wait on (see recordBootTimeline's doc comment).
    recordBootTimeline({
      provider: sandbox.provider,
      sessionId: sandbox.sessionId,
      accountId,
      timeline: body.timeline,
    });

    return c.json({ ok: true });
  },
);
