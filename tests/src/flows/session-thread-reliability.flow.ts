/**
 * Session-thread reliability contracts (T18), pinning the
 * session-middle-stop branch's user-visible fixes:
 *
 *  - phantom "Interrupted" markers after sandbox stop (daemon finalizer
 *    idempotent, typed infra-aborts render nothing — T11)
 *  - stopped-prompt replay (AbortSignal through delivery + web waits on abort
 *    settlement + daemon tri-state boot + server stop aborts the turn first)
 *  - instant session switch (persisted-pin paint, `/start` staleTime, route
 *    veto for cached transcripts)
 *  - duplicate streaming (delta event-id idempotency, T14)
 *
 * REALITY, same as run-session-backlog.flow.ts: every flow here needs a real
 * booted Daytona sandbox with a live OpenCode daemon inside it (the finalizer
 * and the abort-reason classifier both run INSIDE the sandbox process — see
 * apps/kortix-sandbox-agent-server/src/main.ts and
 * packages/sdk/src/core/http/abort-error.ts). None of that exists in the
 * local profile. Every flow is gated `requires: ["funded", "daytona"]`; the
 * local runner self-skips it cleanly (planLocalFlows), and it runs for real
 * against dev-api/staging where those capabilities are funded.
 *
 * There is no Kortix-level session-scoped abort route (confirmed against
 * apps/api/src/projects/routes/*.ts and sandbox-proxy/routes/*.ts — grep for
 * `path:.*abort` returns nothing there). The client-invoked "Stop" action the
 * web app exposes calls OpenCode's OWN `/session/:id/abort` through the
 * preview proxy — the same call RUN-5 already exercises. The
 * server-triggered abort `POST /stop` now performs
 * (`abortLiveTurnBeforeStop`, apps/api/src/projects/reaping/stop-box.ts) is a
 * DIFFERENT call: server-to-daemon `POST {sandbox}/kortix/abort`, HMAC-signed,
 * never reachable from an external client — we observe its effect only
 * through the OpenCode message list, never call it directly.
 *
 * `/transcript` (GET .../sessions/:sessionId/transcript,
 * apps/api/src/projects/lib/session-transcript.ts) is NOT a DB-only read: it
 * early-returns `{available:false}` the instant `project_sessions.status !==
 * 'running'` (confirmed — `stopSession` flips that same column via
 * `applyStoppedState`, apps/api/src/projects/reaping/sandbox-state-sync.ts).
 * So it degrades gracefully once a session is stopped, but it does NOT keep
 * serving the live transcript. The read that genuinely survives a stopped
 * runtime, confirmed DB-only, is the session detail read
 * (`GET .../sessions/:sessionId`) — its `opencode_sessions`/`name` mirror is
 * the exact server-owned snapshot SESS-10 already covers and that the web's
 * "persisted-pin paint" instant-switch fix reads to paint a session before
 * (or without) touching its sandbox at all. SESS-24 below exercises that read
 * for the "message read-back survives a stopped runtime" contract, and also
 * asserts `/transcript`'s own graceful (not erroring) degradation once
 * stopped, so both the real DB-backed path and the documented live-transcript
 * boundary are pinned.
 */
import { flow } from '../core/flow';
import { isKe2eRetryableError } from '../core/client';
import { waitFor, sleep } from '../core/poll';
import { markSessionReadinessTimeoutRetryable } from '../core/session-runtime-retry';
import type { FlowContext } from '../core/types';

// ── Shared helpers (deliberately duplicated from run-session-backlog.flow.ts —
// this suite has no shared session-runtime helper module; every flow file
// owns its own copy, matching the existing convention). ───────────────────

async function waitForSessionReady(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
  timeoutMs = 300_000,
): Promise<any> {
  try {
    return await waitFor(
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/sessions/:sessionId/start',
          {},
          {
            params: { projectId, sessionId },
            query: { wait_ms: '8000' },
            timeoutMs: 25_000,
          },
        );
        if (r.statusCode >= 500 && r.statusCode <= 599) return null;
        r.status(200);
        return r.json<any>();
      },
      {
        until: (s) =>
          s?.stage === 'ready' && Boolean(s?.sandbox?.external_id ?? s?.sandbox?.externalId),
        timeoutMs,
        intervalMs: 3_000,
        description: `session runtime ready for ${sessionId}`,
        retryOnError: isKe2eRetryableError,
      },
    );
  } catch (error) {
    throw markSessionReadinessTimeoutRetryable(error, sessionId);
  }
}

async function bootSandbox(
  ctx: FlowContext,
  opts?: { prompt?: string; readinessTimeoutMs?: number },
): Promise<{ projectId: string; sessionId: string; sandboxId: string; sandbox: any }> {
  const project = await ctx.fixtures.sharedSeededProject();
  const session = await ctx.fixtures.session(project, { prompt: opts?.prompt ?? 'say hello' });
  const started = await waitForSessionReady(ctx, project.id, session.id, opts?.readinessTimeoutMs);
  const sandbox = started.sandbox;
  const sandboxId = String(sandbox.external_id ?? sandbox.externalId);
  return { projectId: project.id, sessionId: session.id, sandboxId, sandbox };
}

const WORKSPACE = '/workspace';

function ocPath(sandboxId: string, suffix: string): string {
  const tail = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `/v1/p/${sandboxId}/8000${tail}`;
}

async function createOcConversation(ctx: FlowContext, sandboxId: string): Promise<string> {
  const ready = await waitFor(
    async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(ocPath(sandboxId, `/session?directory=${encodeURIComponent(WORKSPACE)}`), {});
      if (r.statusCode === 502 || r.statusCode === 503 || r.statusCode === 504) return null;
      return r;
    },
    {
      until: (r) => Boolean(r),
      timeoutMs: 120_000,
      intervalMs: 3_000,
      description: `OpenCode REST ready on sandbox ${sandboxId}`,
    },
  );
  ready!.status([200, 201]);
  const id = ready!.json<any>()?.id;
  if (!id) throw new Error(`OpenCode session create returned no id: ${ready!.text()}`);
  return id;
}

/** Raw OpenCode message row shape (info.role/info.time/info.error), same as
 * OpenCode returns through the proxy — see run-session-backlog.flow.ts's
 * identical local type for the same wire shape. */
type OcMessage = {
  info?: {
    id?: string;
    role?: string;
    time?: { created?: number; completed?: number };
    error?: { name?: string; message?: string } | null;
  };
  id?: string;
  role?: string;
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean }>;
};

function ocRole(m: OcMessage): string | undefined {
  return m.info?.role ?? m.role;
}

function ocId(m: OcMessage): string | undefined {
  return m.info?.id ?? m.id;
}

function ocText(m: OcMessage): string {
  return (m.parts ?? [])
    .filter((p) => p.type === 'text' && !p.synthetic && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

async function listOcMessages(
  ctx: FlowContext,
  sandboxId: string,
  ocSessionId: string,
): Promise<OcMessage[]> {
  const r = await ctx.client
    .as(ctx.P.OWNER)
    .get(ocPath(sandboxId, `/session/${ocSessionId}/message`));
  r.status(200);
  const body = r.json<any>();
  return Array.isArray(body) ? body : [];
}

async function waitForAssistantMarker(
  ctx: FlowContext,
  sandboxId: string,
  ocSessionId: string,
  marker: string,
  timeoutMs = 240_000,
): Promise<OcMessage[]> {
  return waitFor(
    async () => listOcMessages(ctx, sandboxId, ocSessionId),
    {
      until: (messages) =>
        messages.some((m) => ocRole(m) === 'assistant' && ocText(m).includes(marker)),
      timeoutMs,
      intervalMs: 4_000,
      description: `assistant reply containing "${marker}" in OpenCode session ${ocSessionId}`,
    },
  );
}

// ─── RUN-9: Stop → immediate send ─────────────────────────────────────────
// Abort a running turn through OpenCode's OWN runtime abort route (the same
// client-invoked path RUN-5 exercises — this is what the web "Stop" button
// calls) and, with NO settling delay, send a second prompt on the same
// conversation. Pins two contracts at once:
//   1. the second turn's reply addresses ONLY the second prompt — no bleed
//      from the aborted first turn's partial output (the duplicate-streaming
//      class of bug the branch's delta event-id idempotency fix targets);
//   2. the first turn's own last assistant message is left PROPERLY
//      finalized — an abort error AND `time.completed` set — rather than a
//      dangling, never-completed row (the historical cause of a phantom
//      "Interrupted" marker, T11).
flow(
  'RUN-9',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 420_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
    ],
  },
  async (ctx) => {
    const { sandboxId } = await bootSandbox(ctx);
    const ocSessionId = await createOcConversation(ctx, sandboxId);

    await ctx.step('start a long first turn', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(ocPath(sandboxId, `/session/${ocSessionId}/prompt_async`), {
          parts: [
            {
              type: 'text',
              text: 'Write a very long, detailed (2000+ word) essay about the history of railways. Keep writing at length; do not stop early.',
            },
          ],
        });
      r.status([200, 202, 204]);
    });

    await ctx.step('abort it via the runtime abort route while it is still running', async () => {
      // Give the run a moment to actually start producing tokens before
      // aborting — same margin RUN-5 uses.
      await sleep(3_000);
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(ocPath(sandboxId, `/session/${ocSessionId}/abort`), {});
      r.status([200, 204]);
    });

    const secondPromptMarker = `RUN9_TURN_TWO_OK_${Date.now()}`;
    await ctx.step(
      'immediately (no settling delay) send a second, distinct prompt on the same conversation',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(ocPath(sandboxId, `/session/${ocSessionId}/prompt_async`), {
            parts: [
              {
                type: 'text',
                text: `Disregard everything above. Reply with exactly this single token and nothing else: ${secondPromptMarker}`,
              },
            ],
          });
        r.status([200, 202, 204]);
      },
    );

    let messages: OcMessage[] = [];
    await ctx.step(
      'the second turn’s reply appears and addresses ONLY the second prompt (no bleed from the aborted first turn)',
      async () => {
        messages = await waitForAssistantMarker(ctx, sandboxId, ocSessionId, secondPromptMarker);
        const userIdxs = messages.reduce<number[]>((acc, m, i) => {
          if (ocRole(m) === 'user') acc.push(i);
          return acc;
        }, []);
        if (userIdxs.length < 2) {
          throw new Error(
            `expected two user turns in the conversation, saw ${userIdxs.length}: ${JSON.stringify(messages.map((m) => ({ role: ocRole(m), id: ocId(m) })))}`,
          );
        }
        const secondUserIdx = userIdxs[1];
        const turn2Assistants = messages
          .slice(secondUserIdx + 1)
          .filter((m) => ocRole(m) === 'assistant');
        const turn2Text = turn2Assistants.map(ocText).join('\n');
        if (!turn2Text.includes(secondPromptMarker)) {
          throw new Error(`second turn's assistant output missing its own marker: ${turn2Text}`);
        }
        if (/railway/i.test(turn2Text)) {
          throw new Error(
            `second turn's assistant output bled content from the aborted first turn (mentions "railway"): ${turn2Text}`,
          );
        }
      },
    );

    await ctx.step(
      "the first turn's last assistant message carries the abort error with time.completed set",
      async () => {
        const userIdxs = messages.reduce<number[]>((acc, m, i) => {
          if (ocRole(m) === 'user') acc.push(i);
          return acc;
        }, []);
        const secondUserIdx = userIdxs[1];
        const turn1Assistants = messages
          .slice(0, secondUserIdx)
          .filter((m) => ocRole(m) === 'assistant');
        const turn1Last = turn1Assistants[turn1Assistants.length - 1];
        if (!turn1Last) {
          throw new Error('the first (aborted) turn produced no assistant message to finalize');
        }
        const info = turn1Last.info ?? (turn1Last as any);
        if (!info?.time?.completed) {
          throw new Error(
            `the first turn's assistant message has no time.completed set — it is a dangling, never-finalized row (the phantom "Interrupted" class of bug): ${JSON.stringify(turn1Last)}`,
          );
        }
        if (!info?.error) {
          throw new Error(
            `the first turn's assistant message carries no abort error even though it was aborted: ${JSON.stringify(turn1Last)}`,
          );
        }
      },
    );
  },
);

// ─── SESS-23: Park → wake → send ──────────────────────────────────────────
// `POST /stop` now aborts the live turn BEFORE powering the sandbox off
// (`abortLiveTurnBeforeStop`, apps/api/src/projects/reaping/stop-box.ts,
// T11). Waking the box (`/start`) and sending a new prompt must
// deliver that new prompt EXACTLY once — no replay of the original prompt,
// and no additional "Interrupted"/abort stamps beyond the single one the stop
// itself produced (the repeated-Interrupted regression this branch fixes).
flow(
  'SESS-23',
  {
    domain: 'sessions',
    requires: ['funded', 'daytona'],
    timeoutMs: 420_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/stop',
    ],
  },
  async (ctx) => {
    const { projectId, sessionId, sandboxId } = await bootSandbox(ctx);
    const ocSessionId = await createOcConversation(ctx, sandboxId);

    const originalMarker = `SESS23_ORIGINAL_${Date.now()}`;
    await ctx.step('start a long-running turn that will still be live at stop time', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(ocPath(sandboxId, `/session/${ocSessionId}/prompt_async`), {
          parts: [
            {
              type: 'text',
              text: `${originalMarker}: write a very long (2000+ word) essay about the history of clock towers. Keep writing at length.`,
            },
          ],
        });
      r.status([200, 202, 204]);
      await sleep(3_000);
    });

    let preStopUserIds: string[] = [];
    let preStopAbortCount = 0;
    let preStopMessageIds: string[] = [];
    await ctx.step('capture the message baseline before stopping', async () => {
      const messages = await listOcMessages(ctx, sandboxId, ocSessionId);
      preStopMessageIds = messages.map((m) => ocId(m)).filter((id): id is string => Boolean(id));
      preStopUserIds = messages
        .filter((m) => ocRole(m) === 'user')
        .map((m) => ocId(m))
        .filter((id): id is string => Boolean(id));
      preStopAbortCount = messages.filter(
        (m) => ocRole(m) === 'assistant' && Boolean((m.info ?? (m as any))?.error),
      ).length;
    });

    await ctx.step(
      "stop the session's sandbox via the session stop route (aborts the turn first) → 200 stopped",
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/sessions/:sessionId/stop',
          {},
          { params: { projectId, sessionId } },
        );
        r.status(200).body().has('$.status', 'stopped');
      },
    );

    await ctx.step('wake the box back up via /start', async () => {
      await waitForSessionReady(ctx, projectId, sessionId);
    });

    await ctx.step(
      'immediately after wake, before sending anything new: no redelivery of the original prompt, and the abort-stamp count is unchanged',
      async () => {
        const messages = await listOcMessages(ctx, sandboxId, ocSessionId);
        const userIds = messages
          .filter((m) => ocRole(m) === 'user')
          .map((m) => ocId(m))
          .filter((id): id is string => Boolean(id));
        if (userIds.length !== preStopUserIds.length) {
          throw new Error(
            `user-turn count changed across the wake (redelivery?): before=${preStopUserIds.length} after=${userIds.length}`,
          );
        }
        if (JSON.stringify(userIds.sort()) !== JSON.stringify([...preStopUserIds].sort())) {
          throw new Error(
            `user message ids changed across the wake — the original prompt was redelivered as a new message: before=${JSON.stringify(preStopUserIds)} after=${JSON.stringify(userIds)}`,
          );
        }
        const abortCount = messages.filter(
          (m) => ocRole(m) === 'assistant' && Boolean((m.info ?? (m as any))?.error),
        ).length;
        if (abortCount !== preStopAbortCount) {
          throw new Error(
            `abort-marked assistant message count changed on wake alone (no new prompt sent yet) — a new "Interrupted" stamp appeared: before=${preStopAbortCount} after=${abortCount}`,
          );
        }
      },
    );

    const newMarker = `SESS23_AFTER_WAKE_${Date.now()}`;
    await ctx.step('send a new prompt → exactly one delivery', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(ocPath(sandboxId, `/session/${ocSessionId}/prompt_async`), {
          parts: [
            {
              type: 'text',
              text: `Reply with exactly this single token and nothing else: ${newMarker}`,
            },
          ],
        });
      r.status([200, 202, 204]);
    });

    await ctx.step(
      'the wake prompt lands exactly once, and the pre-existing abort-stamp count still has NOT grown',
      async () => {
        const messages = await waitForAssistantMarker(ctx, sandboxId, ocSessionId, newMarker);
        const userIds = messages
          .filter((m) => ocRole(m) === 'user')
          .map((m) => ocId(m))
          .filter((id): id is string => Boolean(id));
        if (userIds.length !== preStopUserIds.length + 1) {
          throw new Error(
            `expected exactly one new user message after the wake prompt, saw ${userIds.length - preStopUserIds.length}: ${JSON.stringify(userIds)}`,
          );
        }
        const assistantsWithMarker = messages.filter(
          (m) => ocRole(m) === 'assistant' && ocText(m).includes(newMarker),
        );
        if (assistantsWithMarker.length !== 1) {
          throw new Error(
            `expected exactly one assistant reply carrying the wake-prompt marker, saw ${assistantsWithMarker.length}`,
          );
        }
        const abortCount = messages.filter(
          (m) => ocRole(m) === 'assistant' && Boolean((m.info ?? (m as any))?.error),
        ).length;
        if (abortCount !== preStopAbortCount) {
          throw new Error(
            `abort-marked assistant message count grew after the wake prompt — a NEW "Interrupted" stamp appeared on top of the pre-existing one(s): before=${preStopAbortCount} after=${abortCount}`,
          );
        }
      },
    );
  },
);

// ─── SESS-24: rapid API-level session switch ──────────────────────────────
// Two sessions, alternated: `/start` must never bleed one session's runtime
// identity into the other's response, a session's live transcript never
// contains the other session's content, and a session's DB-backed detail
// read (the exact snapshot the web's "persisted-pin paint" instant-switch
// fix reads) keeps serving that session's own mirrored data after its
// runtime is stopped — proving the cached-paint read path works without a
// live runtime. See the file header for why this is the session-detail read
// and not `/transcript` (which deliberately degrades once stopped).
flow(
  'SESS-24',
  {
    domain: 'sessions',
    requires: ['funded', 'daytona'],
    timeoutMs: 420_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
      'POST /v1/projects/:projectId/sessions/:sessionId/stop',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.sharedSeededProject();
    const owner = ctx.client.as(ctx.P.OWNER);
    const markerA = `SESS24_SESSION_A_${Date.now()}`;
    const markerB = `SESS24_SESSION_B_${Date.now()}`;
    const sessionA = await ctx.fixtures.session(project, {
      prompt: `Reply with exactly this single token and nothing else: ${markerA}`,
    });
    const sessionB = await ctx.fixtures.session(project, {
      prompt: `Reply with exactly this single token and nothing else: ${markerB}`,
    });

    let sandboxA = '';
    let sandboxB = '';
    await ctx.step('both sessions reach runtime readiness independently', async () => {
      const [startedA, startedB] = await Promise.all([
        waitForSessionReady(ctx, project.id, sessionA.id),
        waitForSessionReady(ctx, project.id, sessionB.id),
      ]);
      sandboxA = String(startedA.sandbox.external_id ?? startedA.sandbox.externalId);
      sandboxB = String(startedB.sandbox.external_id ?? startedB.sandbox.externalId);
      if (!sandboxA || !sandboxB || sandboxA === sandboxB) {
        throw new Error(`expected two distinct sandboxes, got A=${sandboxA} B=${sandboxB}`);
      }
    });

    await ctx.step(
      "a ready session's second /start within 30s is served consistent data (same sandbox identity, still ready)",
      async () => {
        const r = await owner.post(
          '/v1/projects/:projectId/sessions/:sessionId/start',
          {},
          { params: { projectId: project.id, sessionId: sessionA.id }, query: { wait_ms: '3000' } },
        );
        r.status(200).body().has('$.stage', 'ready');
        const body = r.json<any>();
        const external = String(body?.sandbox?.external_id ?? body?.sandbox?.externalId);
        if (external !== sandboxA) {
          throw new Error(
            `second /start within 30s returned a different sandbox identity: first=${sandboxA} second=${external}`,
          );
        }
      },
    );

    await ctx.step(
      'alternating /start reads across the two sessions never cross-bleed sandbox identity',
      async () => {
        const rB = await owner.post(
          '/v1/projects/:projectId/sessions/:sessionId/start',
          {},
          { params: { projectId: project.id, sessionId: sessionB.id }, query: { wait_ms: '3000' } },
        );
        rB.status(200).body().has('$.stage', 'ready');
        const bodyB = rB.json<any>();
        const externalB = String(bodyB?.sandbox?.external_id ?? bodyB?.sandbox?.externalId);
        if (externalB !== sandboxB) {
          throw new Error(
            `session B's /start returned session A's sandbox identity: expected=${sandboxB} got=${externalB}`,
          );
        }
        const rA = await owner.post(
          '/v1/projects/:projectId/sessions/:sessionId/start',
          {},
          { params: { projectId: project.id, sessionId: sessionA.id }, query: { wait_ms: '3000' } },
        );
        rA.status(200).body().has('$.stage', 'ready');
        const bodyA = rA.json<any>();
        const externalA = String(bodyA?.sandbox?.external_id ?? bodyA?.sandbox?.externalId);
        if (externalA !== sandboxA) {
          throw new Error(
            `session A's /start returned session B's sandbox identity: expected=${sandboxA} got=${externalA}`,
          );
        }
      },
    );

    let transcriptSnapshotA: any = null;
    await ctx.step(
      "each session's live transcript contains only its OWN reply marker, never the other session's",
      async () => {
        transcriptSnapshotA = await waitFor(
          async () => {
            const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
              params: { projectId: project.id, sessionId: sessionA.id },
            });
            r.status(200);
            return r.json<any>();
          },
          {
            until: (t) =>
              Boolean(t?.available) &&
              Array.isArray(t?.messages) &&
              t.messages.some((m: any) => typeof m?.text === 'string' && m.text.includes(markerA)),
            timeoutMs: 180_000,
            intervalMs: 4_000,
            description: `session A transcript containing its own marker`,
          },
        );
        const textA = transcriptSnapshotA.messages.map((m: any) => m.text).join('\n');
        if (textA.includes(markerB)) {
          throw new Error(`session A's transcript leaked session B's marker: ${textA}`);
        }

        const transcriptB = await waitFor(
          async () => {
            const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
              params: { projectId: project.id, sessionId: sessionB.id },
            });
            r.status(200);
            return r.json<any>();
          },
          {
            until: (t) =>
              Boolean(t?.available) &&
              Array.isArray(t?.messages) &&
              t.messages.some((m: any) => typeof m?.text === 'string' && m.text.includes(markerB)),
            timeoutMs: 180_000,
            intervalMs: 4_000,
            description: `session B transcript containing its own marker`,
          },
        );
        const textB = transcriptB.messages.map((m: any) => m.text).join('\n');
        if (textB.includes(markerA)) {
          throw new Error(`session B's transcript leaked session A's marker: ${textB}`);
        }
      },
    );

    let detailSnapshotBeforeStop: any = null;
    await ctx.step(
      "session A's detail read exposes the server-owned title/tree mirror before stopping (baseline)",
      async () => {
        detailSnapshotBeforeStop = await waitFor(
          async () => {
            const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId', {
              params: { projectId: project.id, sessionId: sessionA.id },
            });
            r.status(200);
            return r.json<any>();
          },
          {
            until: (row) => {
              const title = typeof row?.name === 'string' ? row.name.trim() : '';
              return Boolean(title) && !/^new (session|agent)\b/i.test(title);
            },
            timeoutMs: 180_000,
            intervalMs: 3_000,
            description: `session A's mirrored title settles`,
          },
        );
      },
    );

    await ctx.step("stop session A's sandbox → 200 stopped", async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/stop',
        {},
        { params: { projectId: project.id, sessionId: sessionA.id } },
      );
      r.status(200).body().has('$.status', 'stopped');
    });

    await ctx.step(
      "the DB-backed session detail read (the web's persisted-pin cached-paint source) still returns the SAME mirrored title/tree for the now-stopped session — the read path works without a live runtime",
      async () => {
        const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId', {
          params: { projectId: project.id, sessionId: sessionA.id },
        });
        r.status(200)
          .body()
          .has('$.name', detailSnapshotBeforeStop.name)
          .has('$.session_id', sessionA.id);
        const body = r.json<any>();
        if (
          JSON.stringify(body.opencode_sessions) !==
          JSON.stringify(detailSnapshotBeforeStop.opencode_sessions)
        ) {
          throw new Error(
            'the mirrored opencode_sessions tree changed (or was wiped) across the stop — the cached-paint read is not stable without a live runtime',
          );
        }
      },
    );

    await ctx.step(
      "the live transcript read degrades gracefully (200, available:false) once stopped — it does not error, but it also does not keep serving live content",
      async () => {
        const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
          params: { projectId: project.id, sessionId: sessionA.id },
        });
        r.status(200).body().has('$.available', false);
      },
    );

    await ctx.step(
      "session B, still running, is unaffected by session A's stop — its transcript is still live and still contains only its own marker",
      async () => {
        const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
          params: { projectId: project.id, sessionId: sessionB.id },
        });
        r.status(200).body().has('$.available', true);
        const body = r.json<any>();
        const text = (body.messages ?? []).map((m: any) => m.text).join('\n');
        if (!text.includes(markerB)) {
          throw new Error(`session B's transcript no longer contains its own marker: ${text}`);
        }
        if (text.includes(markerA)) {
          throw new Error(`session B's transcript picked up session A's marker: ${text}`);
        }
      },
    );
  },
);
