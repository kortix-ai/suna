/**
 * Agents + sessions tool group for the session parity fixture.
 *
 * Story: a lead agent splits work on a small TypeScript web app
 * (`acme-dashboard`) across sub-agents — a research `task`, a running
 * refactor worker (`agent_spawn`), a tracked worker (`task_create`), and two
 * background sessions (`session_spawn`, `session_start_background`) — then
 * steers, inspects, and cleans them up.
 *
 * Child-session resolution (`getChildSessionId`, packages/sdk/src/core/turns/parts.ts):
 * - `task`, `agent_spawn`, `agent_task_update`: `metadata.sessionId` (running + completed);
 * - `task_create`: a `ses_…` token in the running TITLE, then the completed OUTPUT;
 * - `session_spawn` / `session_start_background`: `Session: ses_…` in the OUTPUT only,
 *   so their running state resolves no child on either surface.
 *
 * Every renderer reads the same fields on web and mobile (mobile ports the web
 * parsers into `apps/mobile/lib/session/tools/agents-*.ts` with identical
 * regexes). Divergences are recorded in each spec's `note`.
 */

import type { FixtureToolGroup } from '../types';

const ROOT = '/workspace/acme-dashboard';

// ─── Child session ids (all match /^ses_[A-Za-z0-9]+$/) ──────────────────────

const CHILD_TASK = 'ses_FixtureChildTask';
const CHILD_AGENT_SPAWN = 'ses_FixtureChildAgentSpawn';
const CHILD_TASK_CREATE = 'ses_FixtureChildTaskCreate';
const CHILD_SESSION_SPAWN = 'ses_FixtureChildSessionSpawn';
const CHILD_BACKGROUND = 'ses_FixtureChildBackground';
/** Display-only id for the lead session in session_get / lineage text. Not seeded. */
const LEAD_SESSION = 'ses_FixtureLeadSession';

export const AGENTS_SESSIONS_TOOL_GROUP: FixtureToolGroup = {
  key: 'agents-sessions',
  prompt:
    'acme-dashboard is getting slow and the chart tests are red. Split the work: have one agent map how the dashboard fetches data, one extract the metrics fetching into a hook, and a background session fix the failing chart test. Keep me posted on who is doing what.',
  reasoning:
    'Three independent streams: read-only research, a refactor that touches Dashboard.tsx, and a test fix that needs its own sandbox. Research goes to an explore task, the refactor to a spawned worker with a verification condition, and the test fix to a background session so it can run the suite without blocking. I will track the workers with agent_status and the session tools, and clean up the cancelled sparkline task.',
  summary:
    'The research task finished: Dashboard.tsx fires four uncoordinated fetches on mount and refetches on every filter change. The refactor worker is still extracting `useMetrics` and has my note to keep the 30 s polling interval. The background session fixed the chart test (a locale-dependent number format) and the suite is green, 142 of 142. I cancelled and deleted the obsolete sparkline task.',

  specs: [
    // ─── task ──────────────────────────────────────────────────────────────
    {
      renderer: 'task-tool.tsx',
      tool: 'task',
      input: {
        description: 'Map the dashboard data-fetching layer',
        prompt:
          'Read-only research. In /workspace/acme-dashboard, find every place the dashboard fetches data (fetch, axios, SWR). For each: file, line, endpoint, trigger (mount, filter change, interval). Report duplicated or uncoordinated requests.',
        subagent_type: 'explore',
      },
      title: 'Map the dashboard data-fetching layer',
      output: [
        `task_id: ${CHILD_TASK} (for resuming to continue this task if needed)`,
        '',
        '<task_result>',
        'Dashboard.tsx issues 4 requests on mount and repeats 3 of them on every filter change:',
        '',
        '1. `GET /api/metrics/summary` — src/pages/Dashboard.tsx:41 (useEffect, deps [filters])',
        '2. `GET /api/metrics/timeseries` — src/pages/Dashboard.tsx:58 (useEffect, deps [filters])',
        '3. `GET /api/alerts` — src/components/AlertsPanel.tsx:22 (mount + setInterval 30 s)',
        '4. `GET /api/metrics/summary` — src/components/KpiCard.tsx:17 (duplicate of #1, per card)',
        '',
        'No request is cancelled on filter change, so stale responses can overwrite fresh ones. Recommend one `useMetrics(filters)` hook with an AbortController.',
        '</task_result>',
      ].join('\n'),
      metadata: { sessionId: CHILD_TASK },
      runningTitle: 'Map the dashboard data-fetching layer',
      runningMetadata: { sessionId: CHILD_TASK },
      error: 'Error: Unknown agent type: researcher is not a valid agent type. Available: general, explore',
      durationMs: 48_300,
      note: 'Child id from metadata.sessionId (running + completed). Web opens SubSessionModal from "Full view"; mobile opens the child session in the app (useToolNavigation().openSession). Mobile label is "View".',
    },

    // ─── agent_spawn ───────────────────────────────────────────────────────
    {
      renderer: 'agent-spawn-tool.tsx',
      tool: 'agent_spawn',
      input: {
        title: 'Extract useMetrics hook from Dashboard.tsx',
        description: 'Move the summary + timeseries fetches into one hook',
        prompt:
          'Create src/hooks/useMetrics.ts that owns the summary and timeseries requests for a given filter set, cancels in-flight requests with AbortController, and returns { summary, series, loading, error }. Replace the two useEffect blocks in src/pages/Dashboard.tsx and the per-card fetch in src/components/KpiCard.tsx.',
        agent: 'kortix',
        verification_condition: 'pnpm typecheck and pnpm test src/hooks src/pages both pass',
        background: true,
      },
      title: 'Extract useMetrics hook from Dashboard.tsx',
      output: [
        'Agent spawned in the background.',
        '',
        `Worker session: ${CHILD_AGENT_SPAWN}`,
        '',
        'The worker reports back when the verification condition holds. Check progress with `agent_status`.',
      ].join('\n'),
      metadata: { sessionId: CHILD_AGENT_SPAWN },
      runningMetadata: { sessionId: CHILD_AGENT_SPAWN },
      error: 'Error: Worker limit reached: 4 of 4 concurrent workers are running. Stop one with agent_stop before spawning another.',
      durationMs: 2_100,
      note: 'Background spawn: the call completes while the child stays running. cleanWorkerOutput strips the "Worker session:" token, so the completed body is the verification line plus markdown. Web tappable subtitle opens SubSessionModal; mobile opens the child session in the app.',
    },
    {
      renderer: 'agent-spawn-tool.tsx',
      tool: 'task_create',
      input: {
        title: 'Harden chart tooltip number formatting',
        description: 'Tooltips render 1234.5 as "1,234.5" in en-US and "1.234,5" in de-DE; pin the format.',
        prompt:
          'In src/components/charts/Tooltip.tsx, format values with a shared Intl.NumberFormat("en-US") instance. Add a unit test that runs under TZ=UTC LANG=de_DE.',
        verification_condition: 'pnpm test src/components/charts passes under LANG=de_DE',
      },
      title: 'Create task: Harden chart tooltip number formatting',
      output: `Task **task-q9r8s7t6** created and started. Worker session: ${CHILD_TASK_CREATE}`,
      runningTitle: `task-q9r8s7t6 · ${CHILD_TASK_CREATE}`,
      error: 'Error: Task title already exists: task-q9r8s7t6 "Harden chart tooltip number formatting" is in_progress',
      durationMs: 1_600,
      note: 'Alias with a different output shape: the plugin line is removed entirely by cleanWorkerOutput, so the completed body shows the child\'s last 3 steps plus "+1 more" (child has 4 steps). Child id comes from the running TITLE and the completed OUTPUT, not metadata.',
    },

    // ─── agent_message ─────────────────────────────────────────────────────
    {
      renderer: 'agent-message-tool.tsx',
      tool: 'agent_message',
      input: {
        agent_id: 'agent-k7m2p9x4',
        message:
          'Keep the 30 s polling interval from AlertsPanel out of useMetrics — alerts stay on their own timer.\nAlso export the hook\'s return type as UseMetricsResult.',
      },
      title: 'Message agent-k7m2p9x4',
      output: `Message delivered to agent-k7m2p9x4 (session ${CHILD_AGENT_SPAWN}). The worker reads it after its current step.`,
      metadata: { sessionId: CHILD_AGENT_SPAWN },
      runningMetadata: { sessionId: CHILD_AGENT_SPAWN },
      error: 'Error: Agent agent-k7m2p9x4 is not running (status: completed). Messages can only be sent to running agents.',
      durationMs: 400,
      note: 'Subtitle is input.id || input.agent_id, last 12 chars. Web subtitle opens SubSessionModal; mobile opens the child session in the app.',
    },

    // ─── agent_status ──────────────────────────────────────────────────────
    {
      renderer: 'agent-status-tool.tsx',
      tool: 'agent_status',
      input: {},
      title: 'Agent status',
      output: [
        '## Agent tasks (6)',
        '',
        `- **task-k7m2p9x4** Extract useMetrics hook from Dashboard.tsx — in_progress · session ${CHILD_AGENT_SPAWN}`,
        `- **task-q9r8s7t6** Harden chart tooltip number formatting — completed · session ${CHILD_TASK_CREATE}`,
        '- **task-a1b2c3d4** Map the dashboard data-fetching layer — completed',
        '- **task-w3n5b8v1** Migrate date utils from moment to date-fns — input_needed',
        '- **task-h6j8l0z2** Add Storybook stories for KpiCard — pending',
        '- **task-c3d4e5f6** Rewrite legacy jQuery sparkline — cancelled',
      ].join('\n'),
      error: 'Error: Failed to read task store: ENOENT: no such file or directory, open \'/workspace/.kortix/tasks.json\'',
      durationMs: 300,
      note: 'parseTaskRows needs `**task-[a-z0-9]+** <title> — <status>`; rows cover every status glyph (in_progress, completed, input_needed, pending, cancelled). Rows with a ses_ token open the worker: web SubSessionModal, mobile the session in the app.',
    },

    // ─── agent_stop ────────────────────────────────────────────────────────
    {
      renderer: 'agent-stop-tool.tsx',
      tool: 'agent_stop',
      input: { agent_id: 'agent-r4t6y8u0', reason: 'Superseded by the useMetrics refactor' },
      title: 'Stop agent-r4t6y8u0',
      output: 'Agent agent-r4t6y8u0 stopped after 3 steps. Its session is kept for review.',
      error: 'Error: Agent not found: agent-r4t6y8u0',
      durationMs: 500,
      note: 'Body-less row: subtitle = input.agent_id last 12 chars, args ["stopped"] in every state on both surfaces.',
    },

    // ─── agent_task_update + action aliases ────────────────────────────────
    {
      renderer: 'agent-task-update-tool.tsx',
      tool: 'agent_task_update',
      input: {
        id: 'task-k7m2p9x4',
        action: 'message',
        message: 'Priority change: land the KpiCard change first, Dashboard.tsx second. Push nothing until typecheck is green.',
      },
      title: 'Update task-k7m2p9x4',
      output: 'Message sent to task **task-k7m2p9x4**. The worker resumes with it on its next step.',
      metadata: { sessionId: CHILD_AGENT_SPAWN },
      runningMetadata: { sessionId: CHILD_AGENT_SPAWN },
      error: 'Error: Invalid action "mesage". Expected one of: start, message, approve, cancel',
      durationMs: 350,
      note: 'action "message" routes to AgentMessageTool (subtitle from input.id). getChildSessionId covers agent_task_update, so the subtitle opens the worker session. SDK getToolInfo reads input.task_id here, the renderer reads input.id.',
    },
    {
      renderer: 'agent-task-update-tool.tsx',
      tool: 'task_update',
      input: { id: 'task-a1b2c3d4', action: 'approve' },
      title: 'Approve task-a1b2c3d4',
      output: 'Task **task-a1b2c3d4** approved.',
      error: 'Error: Task task-a1b2c3d4 cannot be approved: status is in_progress, expected completed or input_needed',
      durationMs: 250,
      note: 'action "approve" routes to the body-less success-check row "Update task" · id · ["approved"].',
    },
    {
      renderer: 'agent-task-update-tool.tsx',
      tool: 'agent_task_message',
      input: {
        id: 'task-w3n5b8v1',
        message: 'Use date-fns v3 and remove moment from package.json entirely. Keep the existing format strings.',
      },
      title: 'Message task-w3n5b8v1',
      output: 'Message sent to task **task-w3n5b8v1**. Status changed input_needed → in_progress.',
      error: 'Error: Task not found: task-w3n5b8v1',
      durationMs: 300,
      note: 'Registered straight to AgentMessageTool (no action routing). No child session: the subtitle is not tappable on either surface.',
    },
    {
      renderer: 'agent-task-update-tool.tsx',
      tool: 'agent_task_approve',
      input: {
        id: 'task-q9r8s7t6',
        result:
          'Tooltip values now use one shared Intl.NumberFormat("en-US"). New test Tooltip.locale.test.tsx passes under LANG=de_DE; 12 of 12 chart tests green.',
      },
      title: 'Approve task-q9r8s7t6',
      output: 'Task **task-q9r8s7t6** approved and closed.',
      error: 'Error: Task task-q9r8s7t6 was already approved',
      durationMs: 250,
      note: 'Registered to TaskDoneTool, which renders input.result as the body; include `result` or the row is body-less.',
    },
    {
      renderer: 'agent-task-update-tool.tsx',
      tool: 'agent_task_cancel',
      input: { id: 'task-c3d4e5f6', reason: 'Sparkline is replaced by the Recharts line in KpiCard' },
      title: 'Cancel task-c3d4e5f6',
      output: 'Task **task-c3d4e5f6** cancelled.',
      error: 'Error: Task task-c3d4e5f6 is already cancelled',
      durationMs: 250,
      note: 'Registered to AgentStopTool, which reads only input.agent_id. The wire input carries `id`, so the subtitle is empty on BOTH web and mobile (shared renderer gap, not a surface divergence).',
    },

    // ─── task_list / task_get ──────────────────────────────────────────────
    {
      renderer: 'task-list-tool.tsx',
      tool: 'task_list',
      input: { status: 'all' },
      title: 'Tasks',
      output: [
        '## Tasks (6)',
        '',
        '- **task-k7m2p9x4** Extract useMetrics hook from Dashboard.tsx — `in_progress`',
        '- **task-q9r8s7t6** Harden chart tooltip number formatting — `completed`',
        '- **task-a1b2c3d4** Map the dashboard data-fetching layer — `completed`',
        '- **task-w3n5b8v1** Migrate date utils from moment to date-fns — `input_needed`',
        '- **task-h6j8l0z2** Add Storybook stories for KpiCard — `pending`',
        '- **task-c3d4e5f6** Rewrite legacy jQuery sparkline — `cancelled`',
      ].join('\n'),
      error: 'Error: Invalid status filter "open". Expected one of: all, pending, in_progress, input_needed, completed, cancelled',
      durationMs: 200,
      note: 'Closed by default on both surfaces. Body is markdown: web UnifiedMarkdown, mobile ToolMarkdown in a ScrollView (max-h-48).',
    },
    {
      renderer: 'task-list-tool.tsx',
      tool: 'task_get',
      input: { id: 'task-q9r8s7t6' },
      title: 'Task task-q9r8s7t6',
      output: [
        '### task-q9r8s7t6 — Harden chart tooltip number formatting',
        '',
        '**Status:** completed',
        `**Worker session:** ${CHILD_TASK_CREATE}`,
        '**Verification:** pnpm test src/components/charts passes under LANG=de_DE',
        '',
        '**Result**',
        '',
        'Tooltip values now use one shared `Intl.NumberFormat("en-US")`. Added `Tooltip.locale.test.tsx`.',
        '',
        '| Check | Result |',
        '| --- | --- |',
        '| typecheck | pass |',
        '| chart tests | 12 / 12 |',
      ].join('\n'),
      error: 'Error: Task not found: task-q9r8s7t6',
      durationMs: 200,
      note: 'Alias with a different output shape: one task as a markdown detail with a table, not a list.',
    },

    // ─── task_delete / task_done ───────────────────────────────────────────
    {
      renderer: 'task-delete-tool.tsx',
      tool: 'task_delete',
      input: { id: 'task-c3d4e5f6' },
      title: 'Delete task-c3d4e5f6',
      output: 'Task task-c3d4e5f6 deleted.',
      error: 'Error: Task task-c3d4e5f6 cannot be deleted while in_progress. Cancel it first.',
      durationMs: 200,
      note: 'Body is the static "Task removed" line on both surfaces; the output text is not rendered.',
    },
    {
      renderer: 'task-done-tool.tsx',
      tool: 'task_done',
      input: {
        id: 'task-a1b2c3d4',
        result:
          'Mapped 4 data requests in the dashboard. 3 repeat on every filter change and none are cancelled. Recommendation: one useMetrics(filters) hook with an AbortController.',
      },
      title: 'Task done',
      output: 'Task task-a1b2c3d4 marked done.',
      error: 'Error: task_done can only be called from a worker session',
      durationMs: 150,
      note: 'Body is input.result on both surfaces.',
    },

    // ─── session_spawn / session_start_background ──────────────────────────
    {
      renderer: 'session-spawn-tool.tsx',
      tool: 'session_spawn',
      input: {
        agent: 'kortix',
        project: 'acme-dashboard',
        description: 'Fix the failing chart test',
        prompt:
          'Run `pnpm test` in acme-dashboard. One chart test fails in CI. Find the cause, fix it without skipping the test, and commit on branch fix/chart-test.',
      },
      title: 'Spawned session',
      output: [
        'Background session started.',
        '',
        `- **Session:** ${CHILD_SESSION_SPAWN}`,
        '- **Agent:** kortix',
        '- **Project:** acme-dashboard',
        '',
        'Read results back with `session_read`.',
      ].join('\n'),
      error: 'Error: Failed to provision sandbox for session: provider returned 503 Service Unavailable (retry in 30 s)',
      durationMs: 6_800,
      note: 'Child id only from the completed OUTPUT (`**Session:** ses_…`); running resolves no child. Web draws "Open session" as a Next Link to /projects/:id/sessions/:sid?oc=<child> plus a pulsing dot while running; mobile opens the session in the app and draws KortixLoader. Steps list shows only with forceOpen on both.',
    },
    {
      renderer: 'session-spawn-tool.tsx',
      tool: 'session_start_background',
      input: {
        project: 'acme-dashboard',
        prompt:
          'Measure the production bundle of acme-dashboard with `pnpm build`, list the 5 largest chunks, and report which dependencies dominate them.\nDo not change code.',
      },
      title: 'Started background session',
      output: `Started background session in acme-dashboard.\nSession: ${CHILD_BACKGROUND}`,
      error: 'Error: Project not found: acme-dashbord',
      durationMs: 5_900,
      note: 'Alias with a different shape: no description, so the label falls back to input.project; output uses the plain `Session: ses_…` form.',
    },

    // ─── session_get ───────────────────────────────────────────────────────
    {
      renderer: 'session-get-tool.tsx',
      tool: 'session_get',
      input: { session_id: CHILD_SESSION_SPAWN },
      title: 'Session details',
      output: [
        '=== SESSION: Fix the failing chart test ===',
        `ID: ${CHILD_SESSION_SPAWN}`,
        'Created: 2026-09-17 10:42 | Updated: 2026-09-17 10:51',
        'Changes: 2 files (+31 −4)',
        `Parent: ${LEAD_SESSION}`,
        'Todos:',
        '[completed] Reproduce the failing test',
        '[completed] Pin the tooltip number format',
        '[in_progress] Push fix/chart-test',
        'Storage: 184 MB',
        '=== CONVERSATION (9 msgs, 6 tool calls) ===',
        '**User:** Run `pnpm test` in acme-dashboard and fix the failing chart test.',
        '',
        '**Assistant:** `LineChart.test.tsx` expects `"1,234.5"` but CI runs with `LANG=de_DE`, so `toLocaleString()` returns `"1.234,5"`.',
        '',
        '**Assistant:** Replaced `toLocaleString()` with a shared `Intl.NumberFormat("en-US")`. `pnpm test` → 142 passed.',
        '=== COMPRESSION ===',
        'Compressed 3 older turns (12.4k → 1.9k tokens).',
      ].join('\n'),
      error: `Error: Session not found: ${CHILD_SESSION_SPAWN}`,
      durationMs: 400,
      note: `Exercises meta line (id, created, updated, changes, parent), Todos fold (open), Conversation fold (closed), and compression. Parent ${LEAD_SESSION} is display text only.`,
    },

    // ─── session_lineage ───────────────────────────────────────────────────
    {
      renderer: 'session-lineage-tool.tsx',
      tool: 'session_lineage',
      input: { session_id: CHILD_SESSION_SPAWN },
      title: 'Session lineage',
      output: [
        '## Lineage',
        '',
        `- \`${LEAD_SESSION}\` — acme-dashboard: split perf + test work (root)`,
        `  - \`${CHILD_TASK}\` — Map the dashboard data-fetching layer · completed`,
        `  - \`${CHILD_AGENT_SPAWN}\` — Extract useMetrics hook · running`,
        `  - \`${CHILD_SESSION_SPAWN}\` — Fix the failing chart test · completed ← this session`,
        `  - \`${CHILD_BACKGROUND}\` — Bundle size audit · completed`,
      ].join('\n'),
      error: `Error: Session not found: ${CHILD_SESSION_SPAWN}`,
      durationMs: 300,
      note: 'Arg "N sessions" counts every `ses_` substring (5 here).',
    },

    // ─── session_list / session_list_background / session_list_spawned ─────
    {
      renderer: 'session-list-background-tool.tsx',
      tool: 'session_list_background',
      input: { project: 'acme-dashboard' },
      title: 'Background sessions',
      output: [
        '## Background sessions (3)',
        '',
        `- **${CHILD_SESSION_SPAWN}** status: complete project: acme-dashboard — Fix the failing chart test`,
        `- **${CHILD_BACKGROUND}** status: complete project: acme-dashboard — Bundle size audit`,
        '- **ses_FixtureStaleWorker** status: failed project: acme-dashboard — Upgrade Vite to v6',
      ].join('\n'),
      error: 'Error: Failed to list sessions: request timed out after 10000 ms',
      durationMs: 350,
      note: 'Worker regex needs `**ses_…** … status: <word> … project: <token>` on one line. Status dot: running=info, complete=success, else neutral.',
    },
    {
      renderer: 'session-list-background-tool.tsx',
      tool: 'session_list_spawned',
      input: {},
      title: 'Spawned sessions',
      output: [
        `- **${CHILD_AGENT_SPAWN}** status: running project: acme-dashboard`,
        `- **${CHILD_TASK_CREATE}** status: complete project: acme-dashboard`,
        '- **ses_FixtureDocsWorker** status: running project: acme-docs',
      ].join('\n'),
      error: `Error: No parent session in context: session_list_spawned must run inside a session`,
      durationMs: 300,
      note: 'Alias with a different input shape: no project, so the subtitle is "all projects"; rows span two projects.',
    },
    {
      renderer: 'session-list-background-tool.tsx',
      tool: 'session_list',
      input: { search: 'dashboard' },
      title: 'Sessions',
      output: [
        '| Session | Title | Updated |',
        '| --- | --- | --- |',
        `| \`${LEAD_SESSION}\` | acme-dashboard: split perf + test work | 2026-09-17 10:55 |`,
        `| \`${CHILD_SESSION_SPAWN}\` | Fix the failing chart test | 2026-09-17 10:51 |`,
        '| `ses_FixtureOldDashboard` | Dashboard dark mode polish | 2026-09-02 16:20 |',
      ].join('\n'),
      error: 'Error: Invalid search query: must be at least 2 characters',
      durationMs: 250,
      note: 'Alias with a different output shape: a markdown table with no `status:` rows, so both surfaces render the OutputBlock markdown branch (no worker rows, no "none" arg because the output mentions ses_).',
    },

    // ─── session_message ───────────────────────────────────────────────────
    {
      renderer: 'session-message-tool.tsx',
      tool: 'session_message',
      input: {
        session_id: CHILD_BACKGROUND,
        message:
          'Also report the gzip size of each of the 5 chunks, and flag any chunk that imports moment.',
      },
      title: 'Messaged session',
      output: `Message queued for ${CHILD_BACKGROUND}; delivered on its next turn.`,
      error: `Error: Session ${CHILD_BACKGROUND} is archived and cannot receive messages`,
      durationMs: 300,
      note: 'Closed by default. Body is a "Message" section with the first 500 chars of input.message.',
    },

    // ─── session_read (summary / tools / search) ───────────────────────────
    {
      renderer: 'session-read-tool.tsx',
      tool: 'session_read',
      input: { session_id: CHILD_SESSION_SPAWN, mode: 'summary' },
      title: 'Read session',
      output: [
        '**Status:** idle',
        '**Agent:** kortix',
        '**Messages:** 9',
        '**Tool calls:** 6',
        '**Tools:** bash, read, edit',
        '',
        '### Last assistant message',
        '',
        'Fixed `LineChart.test.tsx`: tooltip values used `toLocaleString()`, which follows `LANG`. They now use a shared `Intl.NumberFormat("en-US")`. `pnpm test` → **142 passed**. Committed `3f9c2e1` on `fix/chart-test`.',
      ].join('\n'),
      error: `Error: Session not found: ${CHILD_SESSION_SPAWN}`,
      durationMs: 450,
      note: 'Summary mode: args idle · 9 msgs · 6 tools; body is markdown.',
    },
    {
      renderer: 'session-read-tool.tsx',
      tool: 'session_read',
      input: { session_id: CHILD_SESSION_SPAWN, mode: 'tools' },
      title: 'Read session tools',
      output: [
        '**Status:** idle',
        '**Tool calls:** 6',
        '',
        '[completed] **bash**: pnpm test -- --reporter=dot',
        '[completed] **read**: src/components/charts/LineChart.test.tsx',
        '[completed] **read**: src/components/charts/Tooltip.tsx',
        '[completed] **edit**: src/components/charts/Tooltip.tsx (+9 −3)',
        '[error] **bash**: pnpm test src/components/charts (1 failed: snapshot obsolete)',
        '[completed] **bash**: pnpm test -- -u && git commit -m "fix(charts): pin tooltip number format"',
      ].join('\n'),
      error: `Error: Session not found: ${CHILD_SESSION_SPAWN}`,
      durationMs: 400,
      note: 'Alias input shape (mode "tools"): body is per-call rows with completed / error glyphs.',
    },
    {
      renderer: 'session-read-tool.tsx',
      tool: 'session_read',
      input: { session_id: CHILD_BACKGROUND, mode: 'search', pattern: 'moment' },
      title: 'Search session',
      output: [
        '**Status:** idle',
        '**Messages:** 5',
        '',
        '2 matches for `/moment/`:',
        '',
        '- Msg 3 [assistant]: `vendor-3a1f.js` (212 kB gzip 61 kB) is dominated by **moment** + locales (168 kB).',
        '- Msg 5 [assistant]: Replacing **moment** with date-fns would cut the largest chunk by ~70%.',
      ].join('\n'),
      error: 'Error: Invalid pattern: Unterminated group',
      durationMs: 350,
      note: 'Alias input shape (mode "search" + pattern): adds the `/moment/` arg; body is markdown.',
    },

    // ─── session_search ────────────────────────────────────────────────────
    {
      renderer: 'session-search-tool.tsx',
      tool: 'session_search',
      input: { query: 'chart tooltip' },
      title: 'Searched sessions',
      output: [
        `${CHILD_SESSION_SPAWN} | "Fix the failing chart test" | 2026-09-17 10:51 | score=14`,
        'Snippet: tooltip values used toLocaleString(), which follows LANG',
        `${CHILD_TASK_CREATE} | "Harden chart tooltip number formatting" | 2026-09-17 10:49 | score=11`,
        'Snippet: one shared Intl.NumberFormat("en-US") instance for every tooltip',
        'ses_FixtureOldDashboard | "Dashboard dark mode polish" | 2026-09-02 16:20 | score=3',
      ].join('\n'),
      error: 'Error: Search index unavailable: session index is rebuilding (try again in 60 s)',
      durationMs: 600,
      note: 'Hit regex: `ses_… | "title" | updated | score=N`, optional `Snippet:` next line. Third hit has no snippet.',
    },

    // ─── session_stats ─────────────────────────────────────────────────────
    {
      renderer: 'session-stats-tool.tsx',
      tool: 'session_stats',
      input: {},
      title: 'Session stats',
      output: [
        '## Session stats — acme-dashboard',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| Sessions | 5 (1 running, 4 idle) |',
        '| Messages | 61 |',
        '| Tool calls | 38 |',
        '| Tokens | 412k in / 38k out |',
        '| Cost | $1.84 |',
        '',
        `Most active: \`${CHILD_SESSION_SPAWN}\` (6 tool calls).`,
      ].join('\n'),
      error: 'Error: Failed to compute stats: database is locked',
      durationMs: 500,
      note: 'Body is markdown on both surfaces.',
    },
  ],

  childSessions: [
    {
      id: CHILD_TASK,
      title: 'Map the dashboard data-fetching layer',
      prompt:
        'Read-only research. In /workspace/acme-dashboard, find every place the dashboard fetches data (fetch, axios, SWR). For each: file, line, endpoint, trigger. Report duplicated or uncoordinated requests.',
      tools: [
        {
          renderer: 'grep-tool.tsx',
          tool: 'grep',
          input: { pattern: 'fetch\\(|axios\\.', path: `${ROOT}/src`, include: '*.tsx' },
          title: 'fetch\\(|axios\\.',
          output: [
            'Found 4 matches',
            `${ROOT}/src/pages/Dashboard.tsx:`,
            '  Line 41:     fetch(`/api/metrics/summary?${qs}`)',
            '  Line 58:     fetch(`/api/metrics/timeseries?${qs}`)',
            '',
            `${ROOT}/src/components/AlertsPanel.tsx:`,
            "  Line 22:   const load = () => axios.get('/api/alerts')",
            '',
            `${ROOT}/src/components/KpiCard.tsx:`,
            '  Line 17:     fetch(`/api/metrics/summary?metric=${metric}`)',
          ].join('\n'),
          error: 'Error: rg exited with code 2',
        },
        {
          renderer: 'read-tool.tsx',
          tool: 'read',
          input: { filePath: `${ROOT}/src/pages/Dashboard.tsx`, offset: 36, limit: 30 },
          title: 'src/pages/Dashboard.tsx',
          output: [
            `<path>${ROOT}/src/pages/Dashboard.tsx</path>`,
            '<type>file</type>',
            '<content>',
            '36: export function Dashboard() {',
            '37:   const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);',
            '38:   const [summary, setSummary] = useState<Summary | null>(null);',
            '39:   useEffect(() => {',
            '40:     const qs = toQuery(filters);',
            '41:     fetch(`/api/metrics/summary?${qs}`)',
            '42:       .then((r) => r.json())',
            '43:       .then(setSummary);',
            '44:   }, [filters]);',
            '</content>',
          ].join('\n'),
          error: `Error: File not found: ${ROOT}/src/pages/Dashboard.tsx`,
        },
        {
          renderer: 'bash-tool.tsx',
          tool: 'bash',
          input: {
            command: 'rg -n "setInterval" src --type tsx',
            description: 'Find polling intervals',
          },
          title: 'Find polling intervals',
          output: 'src/components/AlertsPanel.tsx:25:    const id = setInterval(load, 30_000);',
          error: 'Error: rg: unrecognized file type: tsx',
        },
      ],
      reply:
        'Dashboard.tsx issues 4 requests on mount and repeats 3 of them on every filter change. `KpiCard` duplicates the summary request per card, and nothing cancels in-flight requests. Recommend one `useMetrics(filters)` hook with an AbortController; keep the 30 s alerts poll separate.',
      status: 'completed',
    },
    {
      id: CHILD_AGENT_SPAWN,
      title: 'Extract useMetrics hook from Dashboard.tsx',
      prompt:
        'Create src/hooks/useMetrics.ts that owns the summary and timeseries requests for a given filter set, cancels in-flight requests with AbortController, and returns { summary, series, loading, error }.',
      tools: [
        {
          renderer: 'read-tool.tsx',
          tool: 'read',
          input: { filePath: `${ROOT}/src/components/KpiCard.tsx` },
          title: 'src/components/KpiCard.tsx',
          output: [
            `<path>${ROOT}/src/components/KpiCard.tsx</path>`,
            '<type>file</type>',
            '<content>',
            "1: import { useEffect, useState } from 'react';",
            '2: ',
            '3: export function KpiCard({ metric }: { metric: MetricKey }) {',
            '4:   const [value, setValue] = useState<number | null>(null);',
            '</content>',
          ].join('\n'),
          error: `Error: File not found: ${ROOT}/src/components/KpiCard.tsx`,
        },
        {
          renderer: 'grep-tool.tsx',
          tool: 'grep',
          input: { pattern: 'useEffect', path: `${ROOT}/src/pages` },
          title: 'useEffect',
          output: [
            'Found 2 matches',
            `${ROOT}/src/pages/Dashboard.tsx:`,
            '  Line 39:   useEffect(() => {',
            '  Line 55:   useEffect(() => {',
          ].join('\n'),
          error: 'Error: rg exited with code 2',
        },
      ],
      reply: '',
      status: 'running',
    },
    {
      id: CHILD_TASK_CREATE,
      title: 'Harden chart tooltip number formatting',
      prompt:
        'In src/components/charts/Tooltip.tsx, format values with a shared Intl.NumberFormat("en-US") instance. Add a unit test that runs under TZ=UTC LANG=de_DE.',
      tools: [
        {
          renderer: 'read-tool.tsx',
          tool: 'read',
          input: { filePath: `${ROOT}/src/components/charts/Tooltip.tsx` },
          title: 'src/components/charts/Tooltip.tsx',
          output: [
            `<path>${ROOT}/src/components/charts/Tooltip.tsx</path>`,
            '<type>file</type>',
            '<content>',
            '12: export function ChartTooltip({ value, label }: TooltipProps) {',
            '13:   return <div className="tooltip">{label}: {value.toLocaleString()}</div>;',
            '14: }',
            '</content>',
          ].join('\n'),
          error: `Error: File not found: ${ROOT}/src/components/charts/Tooltip.tsx`,
        },
        {
          renderer: 'grep-tool.tsx',
          tool: 'grep',
          input: { pattern: 'toLocaleString', path: `${ROOT}/src` },
          title: 'toLocaleString',
          output: [
            'Found 2 matches',
            `${ROOT}/src/components/charts/Tooltip.tsx:`,
            '  Line 13:   return <div className="tooltip">{label}: {value.toLocaleString()}</div>;',
            '',
            `${ROOT}/src/components/KpiCard.tsx:`,
            '  Line 31:       {value?.toLocaleString() ?? "—"}',
          ].join('\n'),
          error: 'Error: rg exited with code 2',
        },
        {
          renderer: 'bash-tool.tsx',
          tool: 'bash',
          input: {
            command: 'LANG=de_DE TZ=UTC pnpm vitest run src/components/charts',
            description: 'Run chart tests under de_DE',
          },
          title: 'Run chart tests under de_DE',
          output: [
            ' ✓ src/components/charts/LineChart.test.tsx (7 tests) 184ms',
            ' ✓ src/components/charts/Tooltip.locale.test.tsx (5 tests) 41ms',
            '',
            ' Test Files  2 passed (2)',
            '      Tests  12 passed (12)',
          ].join('\n'),
          error: 'Error: Command exited with code 1',
        },
        {
          renderer: 'bash-tool.tsx',
          tool: 'bash',
          input: { command: 'pnpm typecheck', description: 'Typecheck the app' },
          title: 'Typecheck the app',
          output: '> acme-dashboard@0.4.2 typecheck\n> tsc --noEmit\n',
          error: 'Error: Command exited with code 2',
        },
      ],
      reply:
        'Tooltip values now use one shared `Intl.NumberFormat("en-US")`. Added `Tooltip.locale.test.tsx`; 12 of 12 chart tests pass under `LANG=de_DE`, and typecheck is clean.',
      status: 'completed',
    },
    {
      id: CHILD_SESSION_SPAWN,
      title: 'Fix the failing chart test',
      prompt:
        'Run `pnpm test` in acme-dashboard. One chart test fails in CI. Find the cause, fix it without skipping the test, and commit on branch fix/chart-test.',
      tools: [
        {
          renderer: 'bash-tool.tsx',
          tool: 'bash',
          input: { command: 'LANG=de_DE pnpm test -- --reporter=dot', description: 'Reproduce the CI failure' },
          title: 'Reproduce the CI failure',
          output: [
            ' FAIL  src/components/charts/LineChart.test.tsx > renders formatted tooltip value',
            "AssertionError: expected '1.234,5' to be '1,234.5'",
            '',
            ' Test Files  1 failed | 23 passed (24)',
            '      Tests  1 failed | 141 passed (142)',
          ].join('\n'),
          error: 'Error: Command exited with code 1',
        },
        {
          renderer: 'read-tool.tsx',
          tool: 'read',
          input: { filePath: `${ROOT}/src/components/charts/LineChart.test.tsx`, offset: 20, limit: 12 },
          title: 'src/components/charts/LineChart.test.tsx',
          output: [
            `<path>${ROOT}/src/components/charts/LineChart.test.tsx</path>`,
            '<type>file</type>',
            '<content>',
            "20: it('renders formatted tooltip value', () => {",
            '21:   render(<LineChart data={[{ x: 1, y: 1234.5 }]} />);',
            "22:   hover(screen.getByTestId('point-0'));",
            "23:   expect(screen.getByRole('tooltip')).toHaveTextContent('1,234.5');",
            '24: });',
            '</content>',
          ].join('\n'),
          error: `Error: File not found: ${ROOT}/src/components/charts/LineChart.test.tsx`,
        },
        {
          renderer: 'bash-tool.tsx',
          tool: 'bash',
          input: { command: 'LANG=de_DE pnpm test', description: 'Run the full suite' },
          title: 'Run the full suite',
          output: ' Test Files  24 passed (24)\n      Tests  142 passed (142)\n   Duration  9.84s',
          error: 'Error: Command exited with code 1',
        },
      ],
      reply:
        '`LineChart.test.tsx` failed because tooltip values used `toLocaleString()`, which follows `LANG` (CI runs `de_DE`). Tooltips now use a shared `Intl.NumberFormat("en-US")`. `pnpm test`: 142 of 142 pass. Committed `3f9c2e1` on `fix/chart-test`.',
      status: 'completed',
    },
    {
      id: CHILD_BACKGROUND,
      title: 'Bundle size audit',
      prompt:
        'Measure the production bundle of acme-dashboard with `pnpm build`, list the 5 largest chunks, and report which dependencies dominate them. Do not change code.',
      tools: [
        {
          renderer: 'bash-tool.tsx',
          tool: 'bash',
          input: { command: 'pnpm build 2>&1 | tail -n 8', description: 'Build and list chunk sizes' },
          title: 'Build and list chunk sizes',
          output: [
            'dist/assets/vendor-3a1f.js      212.40 kB │ gzip: 61.02 kB',
            'dist/assets/charts-9b2c.js      148.77 kB │ gzip: 44.10 kB',
            'dist/assets/index-5e8d.js        96.31 kB │ gzip: 29.87 kB',
            'dist/assets/Dashboard-1c4a.js    38.05 kB │ gzip: 11.62 kB',
            'dist/assets/AlertsPanel-7f0e.js  12.90 kB │ gzip:  4.33 kB',
            '✓ built in 7.42s',
          ].join('\n'),
          error: 'Error: Command exited with code 1',
        },
        {
          renderer: 'grep-tool.tsx',
          tool: 'grep',
          input: { pattern: "from 'moment'", path: `${ROOT}/src` },
          title: "from 'moment'",
          output: [
            'Found 3 matches',
            `${ROOT}/src/lib/dates.ts:`,
            "  Line 1: import moment from 'moment';",
            '',
            `${ROOT}/src/components/DateRangePicker.tsx:`,
            "  Line 3: import moment from 'moment';",
            '',
            `${ROOT}/src/pages/Reports.tsx:`,
            "  Line 5: import moment from 'moment';",
          ].join('\n'),
          error: 'Error: rg exited with code 2',
        },
      ],
      reply:
        'Largest chunk: `vendor-3a1f.js`, 212 kB (61 kB gzip). **moment** plus its locales account for 168 kB of it, imported from 3 files. Replacing moment with date-fns would cut that chunk by about 70%.',
      status: 'completed',
    },
  ],
};
