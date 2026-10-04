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
 * booted sandbox, which the local profile does not have. Every flow is gated
 * `requires: ["funded", "daytona"]`; the local runner self-skips it cleanly
 * (planLocalFlows), and it runs for real against a deployed target.
 *
 * RUN-9, SESS-23 and SESS-24 run once per harness (`harnessFlow`) and read the
 * conversation through `GET .../transcript`: live while the session runs, the
 * durable mirror once it is stopped (`source` says which). The client Stop is
 * the runtime abort the web sends (`abortTurn`, fixtures/session-run.ts); no
 * Kortix abort route exists yet. The abort `POST /stop` performs first
 * (`abortLiveTurnBeforeStop`, apps/api/src/services/sandboxes/reaping/stop-box.ts) is a
 * server-to-daemon `POST {sandbox}/kortix/abort`, HMAC-signed and never
 * reachable from an external client, so SESS-23 observes its effect only
 * through the transcript.
 */
import { flow, harnessFlow } from '../core/flow';
import { waitFor } from '../core/poll';
import {
  abortTurn,
  assertRuntimeHarness,
  bootSession,
  endedAfter,
  erroredMessageIds,
  isAbortStamp,
  readTranscript,
  sandboxIdOf,
  sendPrompt,
  stopSessionAndWait,
  waitForAssistantText,
  waitForSessionReady,
  waitForTurn,
  type TranscriptMessage,
} from '../fixtures/session-run';

const MORPH = { providerID: 'kortix', modelID: 'morph-dsv41flash' };

/** Index of the user message whose text contains `marker`, or -1. */
function userIndex(messages: TranscriptMessage[], marker: string): number {
  return messages.findIndex((m) => m.role === 'user' && m.text.includes(marker));
}

// ─── RUN-9: Stop → immediate send ─────────────────────────────────────────
// Stop a running turn the way the web Stop button does (the same call RUN-5
// makes) and, with NO settling delay, send a second prompt. Pins two
// contracts at once:
//   1. the second turn's reply addresses ONLY the second prompt — no bleed
//      from the aborted first turn's partial output (the duplicate-streaming
//      class of bug the branch's delta event-id idempotency fix targets);
//   2. the first turn's own last assistant message is left PROPERLY
//      finalized — `completed` set — rather than a dangling, never-completed
//      row (the historical cause of a phantom "Interrupted" marker, T11).
harnessFlow(
  'RUN-9',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 900_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/turn',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
    ],
  },
  async (ctx, harness) => {
    const session = await bootSession(ctx, harness);
    const { projectId, sessionId } = session;
    const firstMarker = `RUN9_TURN_ONE_${Date.now()}`;

    await ctx.step('start a long first turn', async () => {
      await sendPrompt(
        ctx,
        projectId,
        sessionId,
        `${firstMarker}: write a very long, detailed (2000+ word) essay about the history of railways. Keep writing at length; do not stop early.`,
      );
      await waitForTurn(
        ctx,
        projectId,
        sessionId,
        (t) => t.turns.some((turn) => turn.state === 'active'),
        'the first turn to become active',
        120_000,
      );
    });

    await ctx.step('Stop it while it is still running', async () => {
      await abortTurn(ctx, session);
    });

    const secondMarker = `RUN9_TURN_TWO_OK_${Date.now()}`;
    await ctx.step(
      'immediately (no settling delay) send a second, distinct prompt',
      async () => {
        await sendPrompt(
          ctx,
          projectId,
          sessionId,
          `The railway essay task is canceled. For this new turn, confirm the cancellation by replying with exactly this single token and nothing else: ${secondMarker}`,
        );
      },
    );

    let messages: TranscriptMessage[] = [];
    await ctx.step(
      'the second turn’s reply appears and addresses ONLY the second prompt (no bleed from the aborted first turn)',
      async () => {
        messages = await waitForAssistantText(ctx, projectId, sessionId, secondMarker);
        const first = userIndex(messages, firstMarker);
        const second = userIndex(messages, secondMarker);
        if (first < 0 || second <= first) {
          throw new Error(
            `expected the first prompt (index ${first}) before the second (index ${second}): ${JSON.stringify(messages.map((m) => ({ role: m.role, id: m.id })))}`,
          );
        }
        const turn2Text = messages
          .slice(second + 1)
          .filter((m) => m.role === 'assistant')
          .map((m) => m.text)
          .join('\n');
        if (!turn2Text.includes(secondMarker)) {
          throw new Error(`second turn's assistant output missing its own marker: ${turn2Text}`);
        }
        if (/railway/i.test(turn2Text)) {
          throw new Error(
            `second turn's assistant output bled content from the aborted first turn (mentions "railway"): ${turn2Text}`,
          );
        }
      },
    );

    await ctx.step("the first turn's last assistant message is finalized", async () => {
      const first = userIndex(messages, firstMarker);
      const second = userIndex(messages, secondMarker);
      const turn1 = messages.slice(first + 1, second).filter((m) => m.role === 'assistant');
      const last = turn1[turn1.length - 1];
      if (!last) throw new Error('the first (aborted) turn produced no assistant message to finalize');
      if (!last.completed) {
        throw new Error(
          `the first turn's assistant message has no completed time — a dangling, never-finalized row (the phantom "Interrupted" class of bug): ${JSON.stringify(last)}`,
        );
      }
      // An abort does not guarantee an error on the row: OpenCode stamps
      // `completed` with no error at the end of every processor iteration, and
      // its abort finalizer returns early when `completed` is already set.
      // What must never happen is a genuine provider failure dressed as an
      // abort.
      if (last.error?.name && !isAbortStamp(last)) {
        throw new Error(`the first turn ended on a NON-abort error although it was stopped: ${JSON.stringify(last)}`);
      }
    });
  },
);

// ─── SESS-23: Park → wake → send ──────────────────────────────────────────
// `POST /stop` aborts the live turn BEFORE powering the sandbox off
// (`abortLiveTurnBeforeStop`, apps/api/src/services/sandboxes/reaping/stop-box.ts,
// T11). Waking the box (`/start`) and sending a new prompt must deliver that
// new prompt EXACTLY once — no replay of the original prompt, and no
// additional "Interrupted"/abort stamps beyond the one the stop produced (the
// repeated-Interrupted regression this branch fixes).
harnessFlow(
  'SESS-23',
  {
    domain: 'sessions',
    requires: ['funded', 'daytona'],
    // Un-quarantined in 09aa887a55 (2026-08-24) on the expectation that the
    // stop-time abort + boot-time orphan finalizer had closed the wake path.
    // Its first release-gate run since (v0.13.6, run 32992496089, api shard 2)
    // failed again at 168.7s: `status in [200] — expected [200], got 503` on
    // the first OpenCode read through the preview proxy right after `/start`
    // reported ready — the box was still waking (the "503 = waking state"
    // class), i.e. the same pre-existing stop→wake defect the earlier
    // quarantine documented (#6638 investigation). On Kortix routes
    // (2026-09-28, local stack, 2 of 2 runs) the OpenCode defect reads
    // differently: the first prompt after the wake is recorded
    // "accepted by the runtime but never became a message" and gets no
    // reply. SESS-23-pi passed the same flow. Quarantined until the wake path
    // is proven on a staging dry run
    // (`gh workflow run tests-release.yml --ref staging -f expected_sha=<sha>`);
    // un-quarantine ONLY in the PR that carries that green run.
    quarantine:
      'stop→wake on OpenCode: the first prompt after the wake is accepted by the runtime but never becomes a message, so it gets no reply (local stack 2026-09-28, 2 of 2 runs; pi passes). First seen as a post-wake 503 on gate run 32992496089; quarantined since 2026-08-26',
    // Boot readiness 540_000 + turn start 120_000 + stop settle 60_000 + wake
    // 180_000 + reply 240_000 exceeds 900_000 only when every wait runs to its
    // bound; 1_200_000 matches SESS-24.
    timeoutMs: 1_200_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/turn',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
      'POST /v1/projects/:projectId/sessions/:sessionId/stop',
    ],
  },
  async (ctx, harness) => {
    const { projectId, sessionId } = await bootSession(ctx, harness, {
      opencodeModel: 'morph-dsv41flash',
    });

    const originalMarker = `SESS23_ORIGINAL_${Date.now()}`;
    await ctx.step('start a long-running turn that will still be live at stop time', async () => {
      await sendPrompt(
        ctx,
        projectId,
        sessionId,
        `${originalMarker}: write a very long (2000+ word) essay about the history of clock towers. Keep writing at length.`,
        { model: MORPH },
      );
      await waitForTurn(
        ctx,
        projectId,
        sessionId,
        (t) => t.turns.some((turn) => turn.state === 'active'),
        'the long turn to become active',
        120_000,
      );
    });

    let preStopUserIds: string[] = [];
    let preStopAbortCount = 0;
    await ctx.step('capture the message baseline before stopping', async () => {
      const { messages } = await readTranscript(ctx, projectId, sessionId);
      preStopUserIds = messages.filter((m) => m.role === 'user' && m.id).map((m) => m.id!);
      // Count ABORT stamps only: a provider or gateway failure is a different
      // defect and must not be reported as a new "Interrupted" stamp.
      preStopAbortCount = messages.filter(isAbortStamp).length;
    });

    await ctx.step(
      "stop the session's sandbox via the session stop route (aborts the turn first) → 200 stopped (or stopping, then stopped)",
      async () => {
        // `stop` 409s ("Session is not running") until the session_sandboxes
        // row is `active`; `/start` reporting `ready` proves the RUNTIME
        // answers, not that the row has settled. Retry across that window; a
        // 409 that never clears still fails, with the status the API reported.
        await stopSessionAndWait(ctx, projectId, sessionId, { waitUntilStoppable: true });
      },
    );

    let stoppedAbortCount = 0;
    await ctx.step("the stop's own abort stamps the live turn at most once", async () => {
      // pi stamps the aborted reply `MessageAbortedError`; OpenCode can finalize
      // it with no error at all. Either is one Interrupted marker at most. The
      // stopped session answers from its durable mirror.
      const { messages } = await readTranscript(ctx, projectId, sessionId);
      stoppedAbortCount = messages.filter(isAbortStamp).length;
      if (stoppedAbortCount > preStopAbortCount + 1) {
        throw new Error(`stopping one live turn added ${stoppedAbortCount - preStopAbortCount} abort stamps`);
      }
    });

    await ctx.step('wake the box back up via /start', async () => {
      // A WAKE resumes the VM (~19-25s measured); cold-boot money would let one
      // slow wake swallow the whole flow budget.
      const started = await waitForSessionReady(ctx, projectId, sessionId, 180_000);
      await assertRuntimeHarness(ctx, sandboxIdOf(started), harness);
    });

    let preWakeErrorIds = new Set<string>();
    let afterWakeUserCount = 0;
    await ctx.step(
      'immediately after wake, before sending anything new: no redelivery of the original prompt, and the abort-stamp count is unchanged',
      async () => {
        const { messages } = await readTranscript(ctx, projectId, sessionId);
        const userIds = messages.filter((m) => m.role === 'user' && m.id).map((m) => m.id!);
        if (JSON.stringify([...userIds].sort()) !== JSON.stringify([...preStopUserIds].sort())) {
          throw new Error(
            `user message ids changed across the wake — the original prompt was redelivered: before=${JSON.stringify(preStopUserIds)} after=${JSON.stringify(userIds)}`,
          );
        }
        const abortCount = messages.filter(isAbortStamp).length;
        if (abortCount !== stoppedAbortCount) {
          throw new Error(
            `abort-marked assistant message count changed on wake alone (no new prompt sent yet) — a new "Interrupted" stamp appeared: after stop=${stoppedAbortCount} after wake=${abortCount}`,
          );
        }
        afterWakeUserCount = userIds.length;
        // Errors already present predate the wake prompt and must not be
        // blamed on it by the terminal-turn check.
        preWakeErrorIds = erroredMessageIds(messages);
      },
    );

    const newMarker = `SESS23_AFTER_WAKE_${Date.now()}`;
    await ctx.step('send a new prompt → exactly one delivery', async () => {
      await sendPrompt(
        ctx,
        projectId,
        sessionId,
        `Reply with exactly this single token and nothing else: ${newMarker}`,
        { model: MORPH },
      );
    });

    await ctx.step(
      'the wake prompt lands exactly once, and the abort-stamp count has NOT grown',
      async () => {
        const messages = await waitForAssistantText(ctx, projectId, sessionId, newMarker, {
          knownErrorIds: preWakeErrorIds,
        });
        const userCount = messages.filter((m) => m.role === 'user').length;
        if (userCount !== afterWakeUserCount + 1) {
          throw new Error(
            `expected exactly one new user message after the wake prompt, saw ${userCount - afterWakeUserCount}`,
          );
        }
        const replies = messages.filter((m) => m.role === 'assistant' && m.text.includes(newMarker));
        if (replies.length !== 1) {
          throw new Error(`expected exactly one assistant reply carrying the wake-prompt marker, saw ${replies.length}`);
        }
        const abortCount = messages.filter(isAbortStamp).length;
        if (abortCount !== stoppedAbortCount) {
          throw new Error(
            `abort-marked assistant messages grew after the wake prompt — a NEW "Interrupted" stamp appeared: after stop=${stoppedAbortCount} now=${abortCount}`,
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
// live runtime. The transcript route then serves the durable mirror rather
// than attempting a live read from the stopped sandbox.
harnessFlow(
  'SESS-24',
  {
    domain: 'sessions',
    requires: ['funded', 'daytona'],
    timeoutMs: 1_200_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
      'POST /v1/projects/:projectId/sessions/:sessionId/stop',
    ],
  },
  async (ctx, harness) => {
    const project = await ctx.fixtures.sharedSeededProject(harness);
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
      sandboxA = sandboxIdOf(startedA);
      sandboxB = sandboxIdOf(startedB);
      if (sandboxA === sandboxB) {
        throw new Error(`expected two distinct sandboxes, got A=${sandboxA} B=${sandboxB}`);
      }
      await assertRuntimeHarness(ctx, sandboxA, harness);
      await assertRuntimeHarness(ctx, sandboxB, harness);
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

    await ctx.step("session A's completed turn has a durable transcript before stopping", async () => {
      await waitFor(
        async () => {
          const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
            params: { projectId: project.id, sessionId: sessionA.id },
            query: { shape: 'sync' },
          });
          r.status(200);
          return r.json<any>();
        },
        {
          until: (t) =>
            t?.available === true &&
            t?.source === 'mirror' &&
            t?.complete === true &&
            JSON.stringify(t?.messages ?? []).includes(markerA),
          timeoutMs: 180_000,
          intervalMs: 4_000,
          description: `session A durable transcript containing its own marker`,
        },
      );
    });

    await ctx.step("stop session A's sandbox → 200 stopped (or stopping, then stopped)", async () => {
      await stopSessionAndWait(ctx, project.id, sessionA.id);
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
      "the stopped session's transcript read serves its durable mirror, not the stopped sandbox",
      async () => {
        const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
          params: { projectId: project.id, sessionId: sessionA.id },
        });
        r.status(200).body().has('$.available', true).has('$.source', 'mirror');
        const body = r.json<any>();
        const text = (body.messages ?? []).map((m: any) => m.text).join('\n');
        if (!text.includes(markerA)) {
          throw new Error(`session A's durable mirror lost its own marker: ${text}`);
        }
        if (text.includes(markerB)) {
          throw new Error(`session A's durable mirror contains session B's marker: ${text}`);
        }
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

// ─── SESS-25: the server-side prompt inbox ────────────────────────────────
// A prompt is a DURABLE SERVER ROW from the instant the composer accepts it.
// Before the inbox the queue lived in the browser's localStorage, so a closed
// tab, a second device, or a crash lost queued messages silently and two tabs
// on one session disagreed about what was pending.
//
// Most of what is asserted here is the control plane's own contract — the
// durable row, the idempotency key, the state projection, and the two write
// gates. Whether the runtime then answers the prompt is SESS-23's business.
//
// Boot before delivery assertions. Stop exposes waiting/held immediately,
// including a claimed delivery; the worker checks that hold before each POST.
flow(
  'SESS-25',
  {
    domain: 'sessions',
    requires: ['daytona', 'funded'],
    // Preview run 34938179244 measured a fresh Daytona image build at up to
    // 439s. Readiness now permits that cold path before the inbox assertions.
    timeoutMs: 1_200_000,
    routes: [
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/prompts',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/prompts/:promptId',
      'PATCH /v1/projects/:projectId/sessions/:sessionId/prompts/:promptId',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts/:promptId/retry',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts/hold',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.sharedSeededProject();
    const session = await ctx.fixtures.session(project);
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id, sessionId: session.id };
    await ctx.step('the session runtime is ready before anything is queued', async () => {
      await waitForSessionReady(ctx, project.id, session.id, 540_000);
    });
    const clientMessageId = `q_sess25_${Date.now()}`;
    // The CLIENT mints the wire id: OpenCode orders its transcript by the id's
    // clock prefix, and only a process holding the transcript can place one.
    const wireMessageId = `msg_${((Date.now() - 120_000) * 0x1000)
      .toString(16)
      .slice(-12)
      .padStart(12, '0')}AbCdEfGhIjKlMn`;
    let promptId = '';

    await ctx.step('POST a prompt → 202 with the durable row it created', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/prompts',
        {
          client_message_id: clientMessageId,
          message_id: wireMessageId,
          parts: [{ type: 'text', text: 'SESS-25 inbox prompt' }],
          placement: 'transcript',
          overrides: { directory: '/workspace' },
        },
        { params },
      );
      // BOTH outcomes are correct here, and the test must not pick only one.
      // The ke2e HTTP client retries any request — POST included — on a fetch
      // throw, a timeout, or an edge 502/503/504 (core/client.ts). It carries
      // no test-side idempotency guard, so against deployed staging the FIRST
      // POST is sometimes delivered twice. The server's durable idempotency key
      // then answers the retry with `200 {deduped:true}` naming the SAME row —
      // which is the contract working, not a failure. spec §SESS-25 defines
      // exactly this split: 202 = new row, 200 = idempotent replay.
      r.status([200, 202]).body().has('$.message_id', wireMessageId);
      const posted = r.json<any>();
      const mustBeDeduped = r.statusCode === 200;
      if (posted.deduped !== mustBeDeduped) {
        throw new Error(
          `POST /prompts answered ${r.statusCode} with deduped=${String(posted.deduped)}; ` +
            '202 must carry deduped:false (new row) and 200 must carry deduped:true (replay)',
        );
      }
      promptId = String(posted.prompt_id);
      if (!promptId) throw new Error('POST /prompts returned no prompt_id');
    });

    await ctx.step(
      'a malformed wire id is REFUSED — a mis-ordered id silently drops the turn',
      async () => {
        const r = await owner.post(
          '/v1/projects/:projectId/sessions/:sessionId/prompts',
          {
            client_message_id: `${clientMessageId}_bad`,
            message_id: 'cm_12',
            parts: [{ type: 'text', text: 'nope' }],
          },
          { params },
        );
        r.status(400);
      },
    );

    await ctx.step(
      're-POSTing the SAME client_message_id names the SAME row, never a second one',
      async () => {
        // Enforced by the unique index on `idempotency_key`, not by a cache a
        // second pod would not share.
        const r = await owner.post(
          '/v1/projects/:projectId/sessions/:sessionId/prompts',
          {
            client_message_id: clientMessageId,
            message_id: wireMessageId,
            parts: [{ type: 'text', text: 'SESS-25 inbox prompt' }],
          },
          { params },
        );
        r.status(200).body().has('$.deduped', true).has('$.prompt_id', promptId);
      },
    );

    await ctx.step('GET the inbox → the prompt, with its own client id and text', async () => {
      const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/prompts', { params });
      r.status(200);
      const prompts = r.json<any>().prompts ?? [];
      const mine = prompts.find((p: any) => p.prompt_id === promptId);
      if (!mine) {
        // A delivered prompt is omitted on purpose — it is in the transcript
        // now — so an empty list here is a PASS for the delivery half.
        return;
      }
      if (mine.client_message_id !== clientMessageId) {
        throw new Error(`inbox row carries the wrong client id: ${mine.client_message_id}`);
      }
      if (mine.placement !== 'transcript' || mine.full_text !== 'SESS-25 inbox prompt') {
        throw new Error('Inbox did not preserve placement and full accepted text');
      }
      if (!['queued', 'waiting', 'delivering', 'failed'].includes(mine.state)) {
        throw new Error(`unexpected prompt state: ${mine.state}`);
      }
    });

    await ctx.step('holding the queue is a SERVER fact, not a browser one', async () => {
      const held = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/prompts/hold',
        { held: true },
        { params },
      );
      held.status(200);
      for (const response of [
        held,
        await owner.get('/v1/projects/:projectId/sessions/:sessionId/prompts', { params }),
      ]) {
        response.status(200);
        const mine = (response.json<any>().prompts ?? []).find(
          (p: any) => p.prompt_id === promptId,
        );
        // A consumed prompt is omitted because it belongs to the transcript.
        if (mine && (mine.state !== 'waiting' || mine.reason !== 'held')) {
          throw new Error(`Stop did not persist: ${mine.state}/${mine.reason}`);
        }
      }

      const bad = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/prompts/hold',
        { held: 'yes' },
        { params },
      );
      bad.status(400);

      const released = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/prompts/hold',
        { held: false },
        { params },
      );
      released.status(200);
      for (const prompt of released.json<any>().prompts ?? []) {
        if (prompt.prompt_id === promptId && prompt.reason === 'held') {
          throw new Error('release left the prompt held');
        }
      }
    });

    await ctx.step('retry/send-now names the row, and refuses one on the wire', async () => {
      // One primitive for retry AND "send now": both are the user pointing at a
      // row and asking for that message. A `running` row is already on the wire
      // and answers 404 — re-queueing it would double-deliver.
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/prompts/:promptId/retry',
        {},
        { params: { ...params, promptId } },
      );
      r.status([200, 404]);
    });

    await ctx.step('PATCH edits a waiting prompt in place, or refuses it honestly if it is on the wire', async () => {
      // The queue list's edit: new text, same row, nothing sent. 409 means the
      // agent already has the old text; 404 means it is answered and gone.
      const empty = await owner.patch(
        '/v1/projects/:projectId/sessions/:sessionId/prompts/:promptId',
        { text: '  ' },
        { params: { ...params, promptId } },
      );
      empty.status(400);
      const r = await owner.patch(
        '/v1/projects/:projectId/sessions/:sessionId/prompts/:promptId',
        { text: 'SESS-25 edited prompt' },
        { params: { ...params, promptId } },
      );
      r.status([200, 409, 404]);
      if (r.statusCode === 200) {
        const edited = r.json<any>();
        if (edited.prompt_id !== promptId || edited.full_text !== 'SESS-25 edited prompt') {
          throw new Error(`PATCH did not return the edited row: ${JSON.stringify(edited)}`);
        }
        const listed = await owner.get('/v1/projects/:projectId/sessions/:sessionId/prompts', { params });
        listed.status(200);
        const mine = (listed.json<any>().prompts ?? []).find((p: any) => p.prompt_id === promptId);
        if (mine && mine.full_text !== 'SESS-25 edited prompt') {
          throw new Error(`the queue still lists the old text: ${mine.full_text}`);
        }
      }
    });

    await ctx.step('DELETE removes the prompt, or refuses it honestly if it is on the wire', async () => {
      const r = await owner.del('/v1/projects/:projectId/sessions/:sessionId/prompts/:promptId', {
        params: { ...params, promptId },
      });
      // 200 removed — and the response CARRIES the prompt it removed, because
      // the row is hard-deleted and the UI offers an undo. 409 already being
      // delivered (cancelling would be a lie), 404 already delivered and gone
      // from the inbox. Never a 5xx.
      r.status([200, 409, 404]);
      if (r.statusCode === 200) {
        const removed = r.json<any>().removed;
        if (typeof removed?.client_message_id !== 'string' || !Array.isArray(removed?.parts)) {
          throw new Error(`DELETE did not return the removed prompt: ${JSON.stringify(removed)}`);
        }
      }
    });

    await ctx.step('a prompt id from another session is never addressable here', async () => {
      const other = await ctx.fixtures.session(project);
      const r = await owner.del('/v1/projects/:projectId/sessions/:sessionId/prompts/:promptId', {
        params: { projectId: project.id, sessionId: other.id, promptId },
      });
      r.status(404);
    });
  },
);
