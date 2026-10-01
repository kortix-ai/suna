/**
 * Agent-run + session happy-path backlog.
 *
 * Maps 1:1 to spec IDs: RUN-1..8, RUN-10, RUN-11, SESS-2, SESS-3, SESS-9, SESS-12,
 * FILE-8, FILE-9, GOLD-1, CHN-6, SESS-10, CONN-26.
 *
 * REALITY: every flow here needs a REAL booted sandbox and/or a funded
 * account, which the local target does not have. They are therefore gated at the
 * FLOW level on `requires: ["funded"]` and/or `["daytona"]`. The runner
 * self-skips a flow whose capability is absent, so these SKIP cleanly locally
 * and run for real against a deployed target.
 *
 * ── One body, every harness ─────────────────────────────────────────────────
 * The flows that run a turn are registered with `harnessFlow`: `RUN-1` boots
 * OpenCode and `RUN-1-pi` boots pi (a project with the `pi_harness` flag on).
 * They drive the session through the Kortix routes (`/start`, `/prompts`,
 * `/turn`, `/transcript`, `/events`, `/commit-push`) and never through a
 * harness's own REST API, so a difference between the harnesses fails a named
 * flow. Two calls still use the runtime behind the preview proxy
 * `/p/:sandboxId/:port/*`, because no Kortix route exists for them yet: the
 * Stop abort and the daemon's `/kortix/health` (see fixtures/session-run.ts).
 * That proxy is a Hono wildcard mount, not a manifest route, so it never
 * appears in `meta.routes`; its auth boundary is RUN-8, PRX-1 and PRX-2.
 */
import { flow, harnessFlow } from '../core/flow';
import { isKe2eRetryableError } from '../core/client';
import { waitFor } from '../core/poll';
import type { FlowContext } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';
import { subscribe } from '../fixtures/billing';
import {
  abortTurn,
  assertRuntimeHarness,
  bootSession,
  endedAfter,
  readTranscript,
  readTurn,
  runtimePath,
  sandboxIdOf,
  sendPrompt,
  stopSessionAndWait,
  streamedReplies,
  waitForAssistantText,
  waitForSessionReady,
  waitForTurn,
  watchSessionEvents,
} from '../fixtures/session-run';

const MORPH = { providerID: 'kortix', modelID: 'morph-dsv41flash' };

/** A reply the flow can find by content: the model is told to answer with exactly `marker`. */
function echo(marker: string): string {
  return `Reply with exactly this single token and nothing else: ${marker}`;
}

harnessFlow(
  'SESS-10',
  {
    domain: 'sessions',
    requires: ['funded', 'daytona'],
    serial: true,
    // Boot (≤540s) + one turn (≤240s) + the mirror wait (≤180s) exceeds 360s.
    timeoutMs: 900_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
      'GET /v1/projects/:projectId/sessions',
      'GET /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx, harness) => {
    const session = await bootSession(ctx, harness, {
      prompt: 'Summarize why deterministic end-to-end tests reduce release risk in one sentence.',
    });
    const { projectId, sessionId } = session;

    const marker = `SESS10_MIRROR_${Date.now()}`;
    await ctx.step('a prompt through the session inbox produces assistant output', async () => {
      await sendPrompt(ctx, projectId, sessionId, echo(marker));
      await waitForAssistantText(ctx, projectId, sessionId, marker);
    });

    let mirrored: any = null;
    await ctx.step('the session read exposes a non-placeholder root title and tree', async () => {
      // `metadata.opencode_sessions` is written by a deferred snapshot pass that
      // a delivered prompt arms (prompt+20s, prompt+60s, then it stops). A
      // poll that only waits reads a value whose writer has retired, so re-arm
      // it with another prompt when the wait outlives the pass.
      const REARM_AFTER_MS = 75_000;
      let lastPromptAt = Date.now();
      mirrored = await waitFor(
        async () => {
          if (Date.now() - lastPromptAt > REARM_AFTER_MS) {
            lastPromptAt = Date.now();
            await sendPrompt(ctx, projectId, sessionId, echo(`${marker}_REARM`));
          }
          const response = await ctx.client
            .as(ctx.P.OWNER)
            .get('/v1/projects/:projectId/sessions/:sessionId', { params: { projectId, sessionId } });
          response.status(200);
          return response.json<any>();
        },
        {
          until: (row) => {
            const root = Array.isArray(row?.opencode_sessions)
              ? row.opencode_sessions.find(
                  (entry: any) => entry?.id === row?.opencode_session_id && !entry?.parent_id,
                )
              : null;
            const title = typeof root?.title === 'string' ? root.title.trim() : '';
            const sessionTitle = typeof row?.name === 'string' ? row.name.trim() : '';
            return Boolean(title) && !/^new (session|agent)\b/i.test(title) &&
              Boolean(sessionTitle) && !/^new (session|agent)\b/i.test(sessionTitle);
          },
          timeoutMs: 180_000,
          intervalMs: 3_000,
          description: `the root title/tree mirror for ${sessionId}`,
          retryOnError: isKe2eRetryableError,
        },
      );
    });

    await ctx.step('the project session list returns the same mirrored title and tree', async () => {
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions', { params: { projectId } });
      response.status(200);
      const body = response.json<any>();
      const rows = Array.isArray(body) ? body : (body.sessions ?? []);
      const listed = rows.find((row: any) => row?.session_id === sessionId);
      if (!listed) throw new Error(`session list omitted ${sessionId}`);
      if (listed.name !== mirrored.name) {
        throw new Error(`list title ${String(listed.name)} != detail title ${String(mirrored.name)}`);
      }
      if (JSON.stringify(listed.opencode_sessions) !== JSON.stringify(mirrored.opencode_sessions)) {
        throw new Error('list and detail returned different session trees');
      }
    });
  },
);

// ─── CONN-26: a real agent selects Composio for Gmail ─────────────────────────
flow(
  'CONN-26',
  {
    domain: 'connectors',
    requires: ['funded', 'daytona', 'managedGit'],
    serial: true,
    timeoutMs: 720_000,
    // Added in 5b070ebb18 (2026-08-24, direct push) and never run on a
    // deployed gate before the v0.13.6 release (run 32992496089, api shard
    // 1), where it failed after 392s: `Timed out waiting for Composio Gmail
    // authorization request from agent session ses_fc0decd80ffeYPyIR1B5efRcz3`.
    // CONN-25 passed in the same run (real connect.composio.dev link in 7.4s),
    // so staging holds a working COMPOSIO_API_KEY — the unproven part is the
    // live morph-dsv41flash turn calling `add_connector` inside the 300s wait, and
    // the harness dumps no transcript on that timeout. Quarantined until it
    // passes a staging dry run of tests-release.yml with the transcript
    // captured on failure; un-quarantine ONLY in the PR that carries that
    // green run.
    quarantine:
      'real-agent Composio selection: morph-dsv41flash turn produced no add_connector call / connect.composio.dev link within 300s on staging (gate run 32992496089, api shard 1) — unproven flow, quarantined 2026-08-26 pending a green staging dry run',
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
      'GET /v1/connectors/projects/:projectId/connectors',
      'GET /v1/connectors/projects/:projectId/connectors/:slug/config',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({ managedGit: true });
    const session = await ctx.fixtures.session(project, {
      prompt: 'Reply with the single word READY. Do not call any tools.',
    });
    const params = { projectId: project.id, sessionId: session.id };

    await ctx.step('a fresh remote session boots to a ready runtime', async () => {
      await waitForSessionReady(ctx, project.id, session.id, 360_000);
    });

    await ctx.step('GLM-5.3 744B receives the real Gmail connector request', async () => {
      await sendPrompt(
        ctx,
        project.id,
        session.id,
        'Use the Kortix connector tools now. Add Gmail with the default managed provider and start authorization. Never use Pipedream or any legacy provider. Do not complete OAuth, read mail, or send mail. Stop after you give me the authorization link and ask me to open it.',
        { model: MORPH },
      );
    });

    type FullMessage = { role: string; text: string; tools: Array<{ tool: string; input?: string }> };
    const addConnector = (tool: { tool: string }) => /add[_ -]?connector/i.test(tool.tool);
    let messages: FullMessage[] = [];
    await ctx.step('the agent calls the connector tools and asks the user to authorize', async () => {
      messages = await waitFor(
        async () => {
          // `detail=full` carries each tool call's input as a JSON string.
          const response = await ctx.client
            .as(ctx.P.OWNER)
            .get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
              params,
              query: { limit: '200', detail: 'full', chars: '5000' },
            });
          response.status(200);
          return (response.json<any>().messages ?? []) as FullMessage[];
        },
        {
          until: (rows) => {
            const assistantText = rows
              .filter((message) => message.role === 'assistant')
              .map((message) => message.text)
              .join('\n');
            return (
              rows.some((message) => (message.tools ?? []).some(addConnector)) &&
              assistantText.includes('connect.composio.dev') &&
              /open|authorize|connect/i.test(assistantText)
            );
          },
          timeoutMs: 300_000,
          intervalMs: 4_000,
          description: `Composio Gmail authorization request from session ${session.id}`,
          retryOnError: isKe2eRetryableError,
        },
      );
    });

    await ctx.step('no connector tool call attempted the legacy Pipedream escape hatch', async () => {
      const toolCalls = messages.flatMap((message) => message.tools ?? []);
      const addCalls = toolCalls.filter(addConnector);
      if (addCalls.length === 0) throw new Error('agent emitted no add-connector tool call');
      for (const call of toolCalls) {
        if (/"provider":"pipedream"|"allow_legacy_pipedream":true/.test(call.input ?? '')) {
          throw new Error('agent attempted the legacy Pipedream provider');
        }
      }
      for (const call of addCalls) {
        const provider = /"provider":"([^"]*)"/.exec(call.input ?? '')?.[1];
        if (provider !== undefined && provider !== 'composio') {
          throw new Error(`agent selected unexpected managed provider ${provider}`);
        }
      }
    });

    await ctx.step('project readback proves the agent persisted Gmail through Composio', async () => {
      const listed = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/connectors', {
          params: { projectId: project.id },
        });
      listed.status(200);
      const body = listed.json<any>();
      const rows = Array.isArray(body) ? body : (body?.connectors ?? []);
      const gmail = rows.find(
        (row: any) =>
          row?.provider === 'composio' &&
          (String(row?.slug ?? '').toLowerCase().includes('gmail') ||
            String(row?.name ?? '').toLowerCase().includes('gmail')),
      );
      if (!gmail?.slug) throw new Error('project connector list omitted agent-created Gmail');
      if (
        rows.some(
          (row: any) =>
            row?.provider === 'pipedream' &&
            (String(row?.slug ?? '').toLowerCase().includes('gmail') ||
              String(row?.name ?? '').toLowerCase().includes('gmail')),
        )
      ) {
        throw new Error('project persisted a Pipedream-backed Gmail connector');
      }

      const config = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:projectId/connectors/:slug/config', {
          params: { projectId: project.id, slug: gmail.slug },
        });
      config.status(200).body().has('$.provider', 'composio').has('$.app', 'gmail');
    });
  },
);

// ─── RUN-1: a ready session names its runtime conversation ────────────────────
harnessFlow(
  'RUN-1',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 660_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'GET /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx, harness) => {
    const session = await bootSession(ctx, harness);
    await ctx.step('the ready session names the root conversation its runtime serves', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions/:sessionId', {
          params: { projectId: session.projectId, sessionId: session.sessionId },
        });
      r.status(200).body().has('$.session_id', session.sessionId);
      const root = r.json<any>()?.opencode_session_id;
      if (typeof root !== 'string' || !root) {
        throw new Error(`a ready ${harness} session names no root conversation: ${r.text()}`);
      }
    });
  },
);

// ─── RUN-2: a prompt is accepted durably, then delivered ──────────────────────
harnessFlow(
  'RUN-2',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 660_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
    ],
  },
  async (ctx, harness) => {
    const { projectId, sessionId } = await bootSession(ctx, harness);
    const marker = `RUN2_PONG_${Date.now()}`;
    let promptId = '';
    await ctx.step('POST .../prompts → 202 with a durable prompt id', async () => {
      promptId = await sendPrompt(ctx, projectId, sessionId, echo(marker));
    });
    await ctx.step('the runtime consumes the prompt: the inbox drops it and the transcript holds it', async () => {
      await waitFor(
        async () => {
          const r = await ctx.client
            .as(ctx.P.OWNER)
            .get('/v1/projects/:projectId/sessions/:sessionId/prompts', { params: { projectId, sessionId } });
          r.status(200);
          const mine = (r.json<any>().prompts ?? []).find((p: any) => p.prompt_id === promptId);
          if (mine?.state === 'failed') throw new Error(`prompt delivery failed: ${JSON.stringify(mine)}`);
          return mine ? null : await readTranscript(ctx, projectId, sessionId);
        },
        {
          until: (transcript) =>
            Boolean(transcript?.messages.some((m) => m.role === 'user' && m.text.includes(marker))),
          timeoutMs: 180_000,
          intervalMs: 3_000,
          description: `prompt ${promptId} consumed into the transcript`,
          retryOnError: isKe2eRetryableError,
        },
      );
    });
  },
);

// ─── RUN-3: the session event stream carries the reply as it is written ───────
harnessFlow(
  'RUN-3',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 900_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'GET /v1/projects/:projectId/sessions/:sessionId/events',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
    ],
  },
  async (ctx, harness) => {
    const { projectId, sessionId } = await bootSession(ctx, harness);
    const marker = `RUN3_STREAM_${Date.now()}`;
    await ctx.step('GET .../events streams the reply text and the turn state after a prompt', async () => {
      await watchSessionEvents(
        ctx,
        projectId,
        sessionId,
        async () => {
          await sendPrompt(ctx, projectId, sessionId, echo(marker));
        },
        (seen) =>
          seen.some((frame) => frame.event === 'kortix.control.turn') &&
          streamedReplies(seen).some((text) => text.includes(marker)),
      );
    });
  },
);

// ─── RUN-4: busy → idle, read from the lifecycle authority ────────────────────
harnessFlow(
  'RUN-4',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 660_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/turn',
    ],
  },
  async (ctx, harness) => {
    const { projectId, sessionId } = await bootSession(ctx, harness);
    let before: string | undefined;
    await ctx.step('GET .../turn → idle once the boot prompt has ended', async () => {
      before = (await waitForTurn(ctx, projectId, sessionId, (t) => t.turns.length === 0, 'an idle session'))
        .last_ended?.turn_token;
    });
    await ctx.step('a prompt makes GET .../turn report a running turn', async () => {
      await sendPrompt(ctx, projectId, sessionId, 'Count from one to thirty in words, one number per line.');
      await waitForTurn(ctx, projectId, sessionId, (t) => t.turns.length > 0, 'a running turn', 120_000);
    });
    await ctx.step('the turn ends: no running turn, and last_ended names a completed turn', async () => {
      const ended = await waitForTurn(ctx, projectId, sessionId, endedAfter(before), 'the turn to end');
      if (ended.last_ended?.end_reason !== 'completed') {
        throw new Error(`the turn ended as ${String(ended.last_ended?.end_reason)}, not completed`);
      }
    });
  },
);

// ─── RUN-5: Stop ends a running turn ──────────────────────────────────────────
harnessFlow(
  'RUN-5',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 660_000,
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
    let before: string | undefined;
    const marker = `RUN5_SEA_${Date.now()}`;
    await ctx.step('a long turn is running', async () => {
      before = (await waitForTurn(ctx, projectId, sessionId, (t) => t.turns.length === 0, 'an idle session'))
        .last_ended?.turn_token;
      await sendPrompt(
        ctx,
        projectId,
        sessionId,
        `Start with the line ${marker}, then write a very long (2000+ word) essay about the sea. Do not stop early.`,
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
    await ctx.step('Stop (the runtime abort the web sends) → 200/204', async () => {
      await abortTurn(ctx, session);
    });
    await ctx.step('the turn ends within 60s and its reply is finalized', async () => {
      await waitForTurn(ctx, projectId, sessionId, endedAfter(before), 'the aborted turn to end', 60_000);
      const transcript = await readTranscript(ctx, projectId, sessionId);
      const prompt = transcript.messages.findIndex((m) => m.role === 'user' && m.text.includes(marker));
      const replies = transcript.messages.slice(prompt + 1).filter((m) => m.role === 'assistant');
      if (prompt < 0 || replies.length === 0) {
        throw new Error('the aborted prompt or its assistant message is missing from the transcript');
      }
      const last = replies[replies.length - 1]!;
      if (!last.completed) throw new Error(`the aborted reply was never finalized: ${JSON.stringify(last)}`);
    });
  },
);

// ─── RUN-6: the transcript returns the turn's messages ────────────────────────
harnessFlow(
  'RUN-6',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 660_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
    ],
  },
  async (ctx, harness) => {
    const { projectId, sessionId } = await bootSession(ctx, harness);
    const marker = `RUN6_RESULT_${Date.now()}`;
    await sendPrompt(ctx, projectId, sessionId, echo(marker));
    await ctx.step('GET .../transcript → the prompt, then a completed reply with the marker', async () => {
      await waitForAssistantText(ctx, projectId, sessionId, marker);
      const transcript = await waitFor(() => readTranscript(ctx, projectId, sessionId), {
        until: (t) =>
          t.messages.some((m) => m.role === 'assistant' && m.text.includes(marker) && Boolean(m.completed)),
        timeoutMs: 60_000,
        intervalMs: 2_000,
        description: 'the reply to be completed',
        retryOnError: isKe2eRetryableError,
      });
      if (!transcript.available || transcript.source !== 'live') {
        throw new Error(`a running session must answer live, got ${transcript.source} (${transcript.reason})`);
      }
      const prompt = transcript.messages.findIndex((m) => m.role === 'user' && m.text.includes(marker));
      const reply = transcript.messages.findIndex((m) => m.role === 'assistant' && m.text.includes(marker));
      if (prompt < 0 || reply < prompt) {
        throw new Error(`the reply (index ${reply}) does not follow its prompt (index ${prompt})`);
      }
      for (const m of transcript.messages) {
        if (!m.id || !m.role || !m.created) throw new Error(`a transcript row lacks id/role/created: ${JSON.stringify(m)}`);
      }
    });
  },
);

// ─── RUN-7: an agent change lands on branch <sessionId> ───────────────────────
harnessFlow(
  'RUN-7',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 780_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
      'POST /v1/projects/:projectId/sessions/:sessionId/commit-push',
      'GET /v1/projects/:projectId/files/content',
    ],
  },
  async (ctx, harness) => {
    const session = await bootSession(ctx, harness);
    const { projectId, sessionId } = session;
    const path = `ke2e-run7-${Date.now()}.md`;
    const content = `ke2e-run7-${crypto.randomUUID()}`;
    const done = `RUN7_DONE_${Date.now()}`;
    await ctx.step('the agent writes the requested file in the workspace', async () => {
      await sendPrompt(
        ctx,
        projectId,
        sessionId,
        `Create the file ${path} containing exactly this single line: ${content}. Use the file-writing tool; do not describe the change. Do not commit. Then reply with exactly: ${done}`,
      );
      await waitForAssistantText(ctx, projectId, sessionId, done);
      const file = await ctx.client
        .as(ctx.P.OWNER)
        .get(runtimePath(session.sandboxId, `/file/content?path=${encodeURIComponent(path)}`));
      file.status(200).body().matches('$.content', new RegExp(`^${content}\\n?$`));
    });
    await ctx.step('POST .../commit-push → 200 pushed', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/sessions/:sessionId/commit-push',
          { message: 'ke2e RUN-7 agent change' },
          { params: { projectId, sessionId } },
        );
      r.status(200).body().has('$.pushed', true);
    });
    await ctx.step('the project API reads the file on branch <sessionId>', async () => {
      const file = await waitFor(
        async () =>
          ctx.client
            .as(ctx.P.OWNER)
            .get('/v1/projects/:projectId/files/content', {
              params: { projectId },
              query: { path, ref: sessionId },
            }),
        {
          until: (r) => r.statusCode === 200,
          timeoutMs: 120_000,
          intervalMs: 5_000,
          description: `${path} on branch ${sessionId}`,
          retryOnError: isKe2eRetryableError,
        },
      );
      file.status(200).body().matches('$.content', new RegExp(`^${content}\\n?$`));
    });
  },
);

// ─── RUN-8: proxy authz — no token → 401; share-token → scoped 200 ───────────
// The 401 boundary is on the proxy catch-all (not a manifest route). The
// /v1/p/share mount IS manifest-real and is what mints a scoped preview token.
// One harness: the proxy authenticates before any request reaches a runtime.
flow(
  'RUN-8',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 660_000,
    retry: { attempts: 2 },
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/p/share',
      'DELETE /v1/p/share/:token',
    ],
  },
  async (ctx) => {
    const { sandboxId } = await bootSession(ctx, 'opencode');
    await ctx.step('proxy request with NO token/cookie → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get(runtimePath(sandboxId, '/kortix/health'));
      r.status(401);
    });

    // The mint proxies to the sandbox daemon's /kortix/share. A daemon without
    // share routes answers its /kortix catch-all 404, which the API reports as
    // 501 — so we assert the platform endpoint responds and extract a token if
    // present. (Core coverage here is the 401 boundary + the /v1/p/share mount.)
    let shareToken = '';
    await ctx.step('mint a scoped preview share token (endpoint responds)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/p/share', { sandbox_id: sandboxId, port: 8000 });
      r.status([200, 201, 501]); // 501 = this sandbox daemon has no share routes
      shareToken = r.json<any>()?.token ?? r.json<any>()?.share?.token ?? '';
    });
    if (shareToken) {
      await ctx.step('the share token grants scoped proxy access → 200', async () => {
        const r = await ctx.client
          .as({ label: 'share', auth: { mode: 'query-token', token: shareToken } })
          .get(runtimePath(sandboxId, '/kortix/health'));
        r.status([200, 204, 404]); // 404 = path not served, but auth passed
      });
      await ctx.step('revoke the share token → 200', async () => {
        const r = await ctx.client.as(ctx.P.OWNER).del('/v1/p/share/:token', {
          params: { token: shareToken },
          query: { sandbox_id: sandboxId },
        });
        r.status([200, 204, 404]);
      });
    }
  },
);

// ─── SESS-2: concurrency cap — second session at limit 1 → 429 + headers ────
flow(
  'SESS-2',
  {
    domain: 'sessions',
    requires: ['admin', 'funded', 'daytona'],
    serial: true,
    timeoutMs: 300_000,
    routes: [
      'POST /v1/admin/api/accounts/:id/session-limit',
      'POST /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    if (!ctx.env.adminToken) {
      throw new Error('SESS-2 requires the run-scoped platform-admin token');
    }
    const admin = ctx.client.withBearer(ctx.env.adminToken, 'ADMIN_TOKEN');
    let previousLimit: number | null | undefined;
    const team = await ctx.fixtures.team();

    await ctx.step('fund the isolated session-limit account', async () => {
      await subscribe(ctx.env, ctx.client.as(ctx.P.OWNER), team.id);
    });

    await ctx.step('set the run account concurrent-session override to 1', async () => {
      const r = await admin.post(
        '/v1/admin/api/accounts/:id/session-limit',
        { max_concurrent_sessions: 1 },
        { params: { id: team.id } },
      );
      r.status(200);
      previousLimit = r.json<{ previous: number | null }>().previous;
    });

    try {
      const project = await team.project({ seed: true });
      await ctx.step('first session at limit 1 → 201', async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/projects/:projectId/sessions',
            { initial_prompt: 'noop' },
            { params: { projectId: project.id } },
          );
        r.status(201);
        const body = r.json<{ session_id?: string; id?: string }>();
        const id = body.session_id ?? body.id;
        if (!id) throw new Error(`session create returned no id: ${r.text()}`);
        ctx.track('session', id, { projectId: project.id });
      });

      await ctx.step('second session over limit 1 → 429 + X-RateLimit headers', async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/projects/:projectId/sessions',
            { initial_prompt: 'noop' },
            { params: { projectId: project.id } },
          );
        r.status(429).headerExists('x-ratelimit-limit').headerExists('x-ratelimit-remaining');
      });
    } finally {
      if (previousLimit !== undefined) {
        await ctx.step('restore the previous concurrent-session override', async () => {
          const r = await admin.post(
            '/v1/admin/api/accounts/:id/session-limit',
            { max_concurrent_sessions: previousLimit },
            { params: { id: team.id } },
          );
          r.status(200);
        });
      }
    }
  },
);

// ─── SESS-3: CLI client-branch optimization (server-side contract) ───────────
// The CLI mints a uuid, pushes HEAD:refs/heads/<uuid>, then POSTs the session
// with session_id + branch_already_created:true + base_ref. We assert the
// server-side contract: it accepts a caller-provided session_id and the
// branch_already_created flag and returns 201 with that id.
flow(
  'SESS-3',
  {
    domain: 'sessions',
    requires: ['funded', 'daytona'],
    timeoutMs: 240_000,
    routes: ['POST /v1/projects/:projectId/sessions'],
  },
  async (ctx) => {
    const project = await ctx.fixtures.sharedSeededProject();
    const clientSessionId = crypto.randomUUID();
    await ctx.step(
      'create session with client-minted id + branch_already_created → 201',
      async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/sessions',
          {
            session_id: clientSessionId,
            branch_already_created: true,
            base_ref: 'main',
            initial_prompt: 'noop',
          },
          { params: { projectId: project.id } },
        );
        r.status(201);
        const id = r.json<any>()?.session_id ?? r.json<any>()?.id;
        if (id) ctx.track('session', id, { projectId: project.id });
        // The server should honor the client-supplied id (branch name = session id).
        if (id) r.body().has('$.session_id', clientSessionId);
      },
    );
  },
);

// ─── SESS-9: restart → 202; re-provisions on the same harness ─────────────────
harnessFlow(
  'SESS-9',
  {
    domain: 'sessions',
    requires: ['funded', 'daytona'],
    timeoutMs: 900_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/restart',
    ],
  },
  async (ctx, harness) => {
    const { projectId, sessionId } = await bootSession(ctx, harness);
    await ctx.step('restart → 202 status provisioning', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/sessions/:sessionId/restart',
        {},
        {
          params: { projectId, sessionId },
        },
      );
      r.status(202).body().has('$.status', 'provisioning');
    });
    await ctx.step(`the sandbox re-provisions back to a ready ${harness} runtime`, async () => {
      const started = await waitForSessionReady(ctx, projectId, sessionId);
      await assertRuntimeHarness(ctx, sandboxIdOf(started), harness);
    });
  },
);

// ─── SESS-12: manual stop → 200 status stopped; resumable via /start ──────────
harnessFlow(
  'SESS-12',
  {
    domain: 'sessions',
    requires: ['funded', 'daytona'],
    timeoutMs: 900_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/stop',
    ],
  },
  async (ctx, harness) => {
    const { projectId, sessionId } = await bootSession(ctx, harness);
    await ctx.step('stop → 200 stopped (or stopping, then stopped)', async () => {
      await stopSessionAndWait(ctx, projectId, sessionId);
    });
    await ctx.step('stopping an already-stopped session → 409', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).withTransientGatewayRetries().post(
        '/v1/projects/:projectId/sessions/:sessionId/stop',
        {},
        {
          params: { projectId, sessionId },
        },
      );
      r.status(409);
    });
    await ctx.step(`start resumes the stopped sandbox on ${harness} (disk preserved)`, async () => {
      const started = await waitForSessionReady(ctx, projectId, sessionId);
      await assertRuntimeHarness(ctx, sandboxIdOf(started), harness);
    });
  },
);

/**
 * `POST /start` reports `stage: 'ready'` the moment the sandbox is usable; the
 * session's remote branch publishes separately, fully in the background (see
 * apps/api/src/projects/lib/sessions.ts, "Origin branch creation is publishing
 * work, not readiness work"). `GET /sessions/:id` mirrors that publish through
 * `metadata.remote_branch.status` (`'ready'` | `'failed'`, absent while still
 * in flight). A diff against `refs/heads/<sessionId>` needs the push to have
 * landed — poll for it rather than racing the background job.
 */
async function waitForRemoteBranch(
  ctx: FlowContext,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const branch = await waitFor(
    async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/sessions/:sessionId', {
        params: { projectId, sessionId },
      });
      r.status(200);
      return (r.json<any>()?.metadata?.remote_branch ?? null) as { status?: string; error?: string } | null;
    },
    {
      until: (rel) => rel?.status === 'ready' || rel?.status === 'failed',
      timeoutMs: 120_000,
      intervalMs: 3_000,
      description: `session ${sessionId}'s remote branch to publish`,
    },
  );
  if (branch?.status === 'failed') {
    throw new Error(`remote branch publish failed for session ${sessionId}: ${branch.error ?? 'unknown error'}`);
  }
}

// ─── FILE-8: version-diff between two refs (params from/head + into/base) ─────
flow(
  'FILE-8',
  {
    domain: 'files',
    requires: ['funded', 'daytona'],
    timeoutMs: 360_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'GET /v1/projects/:projectId/version-diff',
    ],
  },
  async (ctx) => {
    // A booted session pushes a branch named <sessionId>; diffing it against main
    // exercises a REAL two-ref diff. (version-diff itself only needs `read`, but
    // we gate the whole flow so it runs where a session branch actually exists.)
    const { projectId, sessionId } = await bootSession(ctx, 'opencode');
    await ctx.step('the session branch is published to origin before diffing it', async () => {
      await waitForRemoteBranch(ctx, projectId, sessionId);
    });
    await ctx.step('version-diff main → <sessionId> → 200 summary', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/version-diff', {
        params: { projectId },
        query: { from: sessionId, into: 'main' },
      });
      r.status(200).body().exists('$.files_changed').has('$.from', sessionId).has('$.into', 'main');
    });
    await ctx.step('the `head`/`base` aliases work identically', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/version-diff', {
        params: { projectId },
        query: { head: sessionId, base: 'main' },
      });
      r.status(200).body().exists('$.files_changed');
    });
    await ctx.step('missing into/base → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/version-diff', {
        params: { projectId },
        query: { from: sessionId },
      });
      r.status(400);
    });
  },
);

// ─── FILE-9: live file CRUD inside the sandbox via the daemon file API ────────
// Through the preview proxy on :8000. Durable truth is the git repo; the sandbox
// tree is ephemeral. The daemon's /file routes live under the proxy catch-all,
// so they are driven at runtime but not declared as coverage routes. They are
// host routes, the same on every harness, so one harness proves them.
flow(
  'FILE-9',
  {
    domain: 'files',
    requires: ['funded', 'daytona'],
    timeoutMs: 600_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
    ],
  },
  async (ctx) => {
    // `/start` answers `ready` only once the daemon reports its runtime ready,
    // so the file routes below never meet a booting daemon.
    const { sandboxId } = await bootSession(ctx, 'opencode', { readinessTimeoutMs: 420_000 });
    const path = `ke2e-file-${Date.now()}.txt`;
    const content = 'ke2e live file crud';

    await ctx.step('upload a file into the sandbox workspace → 200', async () => {
      // The daemon owns writes through multipart POST /file/upload. A raw PUT
      // /file is not a write contract and falls through to the runtime catch-all.
      const form = new FormData();
      form.append('path', '.');
      form.append('file', new File([content], path, { type: 'text/plain' }));
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .request('POST', runtimePath(sandboxId, '/file/upload'), { body: form });
      r.status(200).body().has('$[0].size', content.length);
    });
    await ctx.step('read it back → 200 with the content', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get(runtimePath(sandboxId, `/file/content?path=${encodeURIComponent(path)}`));
      r.status(200)
        .body()
        .has('$.type', 'text')
        .has('$.content', content)
        .has('$.size', content.length);
    });
    await ctx.step('list the directory → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(runtimePath(sandboxId, '/file?path=.'));
      r.status([200, 204]);
    });
    await ctx.step('delete it → 200', async () => {
      // The daemon's DELETE /file takes the path in a JSON body { path }, not a
      // query param (routes/files.ts: `app.delete('/', … req.json().path`).
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del(runtimePath(sandboxId, '/file'), { body: { path } });
      r.status([200, 204, 404]);
    });
  },
);

// ─── GOLD-1: the golden master flow (init → ship → run → merge) ──────────────
// The single flow that, if green, proves the platform end-to-end. We drive the
// HTTP-observable portions (the CLI-local steps init/login/ship are exercised by
// the CLI suite; here we provision the project + session via fixtures, run the
// agent, open a CR, preview, and merge).
flow(
  'GOLD-1',
  {
    domain: 'golden',
    requires: ['funded', 'daytona'],
    serial: true,
    timeoutMs: 600_000,
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
      'POST /v1/projects/:projectId/sessions/:sessionId/commit-push',
      'GET /v1/projects/:projectId/snapshots',
      'POST /v1/projects/:projectId/change-requests',
      'GET /v1/projects/:projectId/change-requests/:crId/merge-preview',
      'POST /v1/projects/:projectId/change-requests/:crId/merge',
      'DELETE /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({ seed: true });

    await ctx.step('a ready snapshot exists for the base ref', async () => {
      await waitFor(
        async () => {
          const r = await ctx.client
            .as(ctx.P.OWNER)
            .get('/v1/projects/:projectId/snapshots', { params: { projectId: project.id } });
          return r.statusCode === 200 ? r.json<any>() : null;
        },
        {
          until: (body) => {
            // GET /snapshots returns { templates: [{ ready, daytona_state, … }], builds: [] }.
            // A template is usable when ready===true (or its provider state is active).
            const templates =
              body?.templates ?? (Array.isArray(body) ? body : (body?.snapshots ?? []));
            return (
              Array.isArray(templates) &&
              templates.some(
                (t: any) =>
                  t?.ready === true ||
                  t?.status === 'ready' ||
                  t?.provider_state === 'active' ||
                  (Array.isArray(t?.provider_coverage) &&
                    t.provider_coverage.some(
                      (provider: any) =>
                        provider?.launch_ready === true || provider?.status === 'ready',
                    )),
              )
            );
          },
          timeoutMs: 480_000,
          intervalMs: 6_000,
          description: `a ready snapshot for project ${project.id}`,
        },
      );
    });

    const session = await ctx.fixtures.session(project, {
      prompt: 'add a README.md describing this project',
    });
    let sandboxId = '';
    await ctx.step('session sandbox boots to active', async () => {
      sandboxId = sandboxIdOf(await waitForSessionReady(ctx, project.id, session.id));
    });

    const goldenPath = `golden-e2e-${Date.now()}.md`;
    const goldenMarker = `golden-e2e-${crypto.randomUUID()}`;
    const goldenDone = `GOLD1_DONE_${Date.now()}`;
    await ctx.step('agent writes the requested file and produces output', async () => {
      await sendPrompt(
        ctx,
        project.id,
        session.id,
        `Create the file ${goldenPath} containing exactly this single line: ${goldenMarker}. Use the file-writing tool; do not merely describe the change. Then reply with exactly: ${goldenDone}`,
      );
      await waitForAssistantText(ctx, project.id, session.id, goldenDone);
      const file = await ctx.client
        .as(ctx.P.OWNER)
        .get(runtimePath(sandboxId, `/file/content?path=${encodeURIComponent(goldenPath)}`));
      file
        .status(200)
        .body()
        .matches('$.content', new RegExp(`^${goldenMarker}\\n?$`));
    });

    await ctx.step("commit and push the agent's workspace change", async () => {
      const committed = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/sessions/:sessionId/commit-push',
          { message: 'Add golden end-to-end fixture' },
          { params: { projectId: project.id, sessionId: session.id } },
        );
      committed.status(200).body().has('$.pushed', true);
    });

    let crId = '';
    await ctx.step('open a change request from the session branch → 201', async () => {
      // The host commit-push invalidates the mirror immediately, but tolerate
      // a brief provider-ref propagation window before asserting the CR.
      const r = await waitFor(
        async () => {
          const resp = await ctx.client
            .as(ctx.P.OWNER)
            .post(
              '/v1/projects/:projectId/change-requests',
              { head_ref: session.id, title: ctx.fixtures.name('golden-cr') },
              { params: { projectId: project.id } },
            );
          // The branch can be unknown briefly (400), or exist without being
          // ahead of base yet (422 CR_HEAD_NOT_AHEAD). Both mean the async
          // agent commit is not observable yet, so keep polling.
          return resp.statusCode === 400 || resp.statusCode === 422 ? null : resp;
        },
        {
          until: (resp) => Boolean(resp),
          timeoutMs: 240_000,
          intervalMs: 6_000,
          description: `session branch ${session.id} has a committable diff (agent committed)`,
        },
      );

      if (!r) throw new Error('change request did not become observable');
      r.status(201);
      crId = r.json<any>()?.change_request?.id ?? r.json<any>()?.cr_id ?? r.json<any>()?.id ?? '';
      if (crId) ctx.track('change-request', crId, { projectId: project.id });
    });

    await ctx.step('merge-preview reports mergeable', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/change-requests/:crId/merge-preview', {
          params: { projectId: project.id, crId },
        });
      r.status(200);
    });

    await ctx.step('merge the CR → 200 merged', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/change-requests/:crId/merge',
        {},
        {
          params: { projectId: project.id, crId },
        },
      );
      r.status(200).body().has('$.change_request.status', 'merged');
    });

    await ctx.step('delete the session → 200 stopped (branch preserved)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/projects/:projectId/sessions/:sessionId', {
          params: { projectId: project.id, sessionId: session.id },
        });
      r.status(200);
    });
  },
);

// ─── CHN-6: Slack dispatch creates/continues a session ───────────────────────
// app_mention/IM/threaded message → existing thread session (continue it via the
// canonical projects/session-delivery `deliverPromptToSession`) else
// createProjectSession(actor=owner, agent `default`) + record chat_threads.
//
// BOUNDARY NOTE: the dispatch is reached via the BYO per-project webhook
// (POST /v1/webhooks/slack/:projectId). It requires a stored per-project Slack
// signing secret (loadSlackSigningSecretForProject) — which is only persisted
// via `channels/slack/connect`, and that route validates a REAL `xoxb-` token
// through Slack's `auth.test`. Without a real Slack workspace+app (true even on
// dev-api unless one is wired) the project has no install → the webhook returns
// 404 BEFORE it can dispatch, so createProjectSession is unreachable in a
// black-box run. We therefore drive the real dispatch entry point and assert the
// closest real boundary: a `event_callback`/`app_mention` POST is accepted and
// (when an install + signature are present on the target) acknowledged 200
// `{ok:true}` and a `source:slack` session subsequently appears; otherwise the
// install gate (404) is asserted. This flow is gated on funded+daytona because a
// successful dispatch spins a real sandbox.
flow(
  'CHN-6',
  {
    domain: 'channels',
    requires: ['funded', 'daytona'],
    serial: true,
    timeoutMs: 240_000,
    routes: ['POST /v1/webhooks/slack/:projectId', 'GET /v1/projects/:projectId/sessions'],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const event = {
      type: 'event_callback',
      event_id: `Ev${Date.now()}`,
      team_id: 'T_KE2E',
      event: {
        type: 'app_mention',
        user: 'U_KE2E',
        text: '<@U_BOT> please add a changelog entry',
        channel: 'C_KE2E',
        ts: `${Date.now() / 1000}`,
      },
    };

    await ctx.step('app_mention to the BYO webhook reaches the dispatch boundary', async () => {
      // No valid per-project signing secret is stored (connect needs real Slack),
      // so the documented boundary is: 404 (no install) is the deterministic
      // outcome here; 200 {ok:true} only if a real install+signature exist on the
      // target. Either proves we hit the real BYO dispatch route.
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/webhooks/slack/:projectId', event, { params: { projectId: project.id } });
      r.status([200, 401, 404]);
      if (r.statusCode !== 200) {
        ctx.skip(
          'no real Slack install on this target — dispatch (createProjectSession) ' +
            'requires a connected workspace; asserted the BYO webhook install gate instead',
        );
      }
      r.body().has('$.ok', true);
    });

    await ctx.step('a slack-sourced session is created for the project', async () => {
      // Only reached when the webhook returned 200 (a real install dispatched).
      await waitFor(
        async () => {
          const r = await ctx.client
            .as(ctx.P.OWNER)
            .get('/v1/projects/:projectId/sessions', { params: { projectId: project.id } });
          return r.statusCode === 200 ? r.json<any>() : null;
        },
        {
          until: (body) => {
            const list = Array.isArray(body) ? body : (body?.sessions ?? []);
            return Array.isArray(list) && list.some((s: any) => s?.metadata?.source === 'slack');
          },
          timeoutMs: 120_000,
          intervalMs: 4_000,
          description: `a source:slack session for project ${project.id}`,
        },
      );
    });
  },
);

/**
 * A manifest with one extra agent, `no-edit`, whose `.md` denies every way to
 * write a file: the file tools (`edit`), the shell (`bash`, which also covers
 * OpenCode's `pty_*` tools, W5 E9), and delegation.
 */
const NO_EDIT_FILES = {
  'kortix.yaml': [
    'kortix_version: 2',
    'default_agent: kortix',
    'agents:',
    '  kortix:',
    '    kortix_permissions: all',
    '    skills: all',
    '  no-edit:',
    '    kortix_permissions: all',
    '',
  ].join('\n'),
  '.kortix/opencode/agents/no-edit.md': [
    '---',
    'description: Reads this repository and never writes files.',
    'mode: primary',
    'permission:',
    '  edit: deny',
    '  bash: deny',
    '  task: deny',
    '---',
    'You answer questions about this repository. Follow the user instructions exactly.',
    '',
  ].join('\n'),
};

harnessFlow(
  'RUN-10',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    // Boot (≤540s) + the boot turn (≤240s).
    timeoutMs: 900_000,
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'GET /v1/projects/:projectId/sessions/:sessionId/turn',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
    ],
  },
  async (ctx, harness) => {
    const project = await ctx.fixtures.project({ seed: true });
    const world = await AgentPrincipalsWorld.open(ctx, { accountId: project.accountId ?? ctx.P.OWNER.accountId!, projectId: project.id });
    try {
      await ctx.step(`the project declares a no-edit agent and runs ${harness}`, async () => {
        if (harness === 'pi') await world.setFeature('pi_harness', true);
        await world.commitToMain(NO_EDIT_FILES, 'ke2e RUN-10: a no-edit agent');
      });
      const path = `ke2e-run10-${Date.now()}.txt`;
      const done = `RUN10_DONE_${Date.now()}`;
      // The boot prompt runs on the session's agent on every harness; a later
      // /prompts delivery may name no agent.
      const session = await bootSession(ctx, harness, {
        project,
        agentName: 'no-edit',
        prompt:
          `Call your file-writing tool (write) once to create the file ${path} containing the single line OK. ` +
          // OpenCode's pty plugin tools never asked for permission, so `bash: deny` did not stop them.
          (harness === 'opencode'
            ? `If you have no file-writing tool but have a pty_spawn tool, call pty_spawn once with command "sh" and args ["-c", "printf OK > ${path}"] instead. `
            : '') +
          `Use no other tool. Whatever the tool returns, then reply with exactly: ${done}`,
      });
      await ctx.step('no file or pty tool ran; on pi the write was attempted and refused', async () => {
        const messages = await waitForAssistantText(ctx, session.projectId, session.sessionId, done);
        // `bash: deny` and `edit: deny` also cover the shell and file-writing
        // tools that do the same job: pty_* and memory.
        const fileTools = messages
          .flatMap((m) => m.tools ?? [])
          .filter((t) => t.tool === 'write' || t.tool === 'edit' || t.tool === 'memory' || t.tool.startsWith('pty_'));
        const ran = fileTools.filter((t) => t.status !== 'error');
        if (ran.length > 0) throw new Error(`a denied file tool ran: ${JSON.stringify(ran)}`);
        // OpenCode never offers a tool its policy denies, so its model has no
        // write tool to call. pi offers every tool and refuses the call; a
        // refused `write` is the proof that `edit: deny` reached it.
        if (harness === 'pi' && fileTools.length === 0) {
          throw new Error(`the pi agent never called a file tool, so the policy was not exercised: ${JSON.stringify(messages.map((m) => m.tools))}`);
        }
      });
      await ctx.step('the file does not exist in the workspace', async () => {
        const file = await ctx.client
          .as(ctx.P.OWNER)
          .get(runtimePath(session.sandboxId, `/file/content?path=${encodeURIComponent(path)}`));
        file.status(404);
      });
    } finally {
      await world.close();
    }
  },
);

flow(
  'RUN-11',
  {
    domain: 'agent-run',
    requires: ['funded', 'daytona'],
    timeoutMs: 900_000,
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/start',
      'GET /v1/projects/:projectId/sessions/:sessionId/turn',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({ seed: true });
    await ctx.step('the project asks for pi and turns the LLM gateway off', async () => {
      for (const [feature, enabled] of [['pi_harness', true], ['llm_gateway', false]] as const) {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .patch('/v1/projects/:projectId/features', { feature, enabled }, { params: { projectId: project.id } });
        r.status(200).body().has(`$.experimental.${feature}`, enabled);
      }
    });
    // pi has no model path without the gateway: the session boots OpenCode,
    // and bootSession proves it from the daemon's health.
    await bootSession(ctx, 'opencode', { project });
  },
);
