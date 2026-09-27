/**
 * Assembles the parity fixture session from the declarative tool groups.
 *
 * Deterministic: every id comes from a counter and every timestamp from
 * `FIXTURE_T0`, so two builds are deep-equal and a screenshot of one build
 * matches a screenshot of the next.
 *
 * Turn order (display order — message ids sort lexicographically):
 *   1. attachments + markdown — user message with file/agent mentions, one
 *      image FilePart, three `<file>` uploads, clamped long text; the reply is
 *      the markdown document (reasoning + text).
 *   2. one settled turn per tool group — every spec in its completed and
 *      error states, then a closing summary.
 *   3. part internals — subtask, step-start/finish with snapshots, patch,
 *      snapshot, retry, assistant file part.
 *   4. error turns — provider error with the gateway envelope, insufficient
 *      credits, usage limit.
 *   5. compaction — request marker + landed summary.
 *   6. aborted turn, then an interrupted prompt with no reply.
 *   7. the working turn — every spec in its pending and running states, a
 *      streaming reasoning part, streaming text, the unanswered question, and
 *      a call waiting on a permission.
 *   8. a queued prompt behind the working turn.
 */

import { FIXTURE_MARKDOWN_DOCUMENT } from './markdown';
import { AGENTS_SESSIONS_TOOL_GROUP } from './tools/agents-sessions';
import { CONNECTORS_PROJECTS_TOOL_GROUP } from './tools/connectors-projects';
import { FILES_SHELL_TOOL_GROUP } from './tools/files-shell';
import { WEB_MEMORY_TOOL_GROUP } from './tools/web-memory';
import type {
  FixtureAssistantMessage,
  FixtureChildSessionSpec,
  FixtureMessageError,
  FixtureMessageWithParts,
  FixturePart,
  FixturePermissionRequest,
  FixtureStepFinishPart,
  FixtureStepStartPart,
  FixtureToolStateRunning,
  FixtureQuestionRequest,
  FixtureQueueState,
  FixtureSessionStatus,
  FixtureTokens,
  FixtureToolCoverage,
  FixtureToolGroup,
  FixtureToolPart,
  FixtureToolSpec,
  FixtureToolStatus,
  FixtureUserMessage,
  SessionFixture,
} from './types';

// ─── Constants ───────────────────────────────────────────────────────────────

/** 2026-09-16T09:00:00.000Z. Every timestamp is an offset from this instant. */
export const FIXTURE_T0 = Date.UTC(2026, 8, 16, 9, 0, 0);
export const FIXTURE_SESSION_ID = 'ses_FixtureParityRoot';
export const FIXTURE_SESSION_TITLE = 'Advisory lock rollout';
export const FIXTURE_AGENT_NAMES = ['build', 'plan', 'explore', 'general'];
const MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' } as const;
const PATH = { cwd: '/workspace/acme-dashboard', root: '/workspace/acme-dashboard' } as const;
const ALL_STATES: readonly FixtureToolStatus[] = ['pending', 'running', 'completed', 'error'];

/** Tool groups in turn order. */
export const FIXTURE_TOOL_GROUPS: readonly FixtureToolGroup[] = [
  FILES_SHELL_TOOL_GROUP,
  WEB_MEMORY_TOOL_GROUP,
  AGENTS_SESSIONS_TOOL_GROUP,
  CONNECTORS_PROJECTS_TOOL_GROUP,
];

/** A 64×40 PNG in four sky-blue bands. Inline, so no network request loads it. */
export const FIXTURE_IMAGE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAUUlEQVR42u3PUQnAIAAFQBMsj+WMsxKCKewg2MCPDczx4OAKXHneHa0ICAgICAhEB+o40QQEBAQEBLIDbX7RBAQEBAQEsgN9/dEEBAQEBASiXTpVHjxIVurmAAAAAElFTkSuQmCC';

// ─── Deterministic ids and clock ─────────────────────────────────────────────

/**
 * Wire-shaped ids: `msg_` + 12 lowercase hex digits sorts in creation order
 * and matches the SDK's display-order regex (`/^msg_[0-9a-f]{12}/`).
 */
function createIds() {
  let message = 0;
  let part = 0;
  let call = 0;
  const hex = (n: number) => n.toString(16).padStart(12, '0');
  return {
    message: () => `msg_${hex((message += 1))}FixtureParity`,
    part: () => `prt_${hex((part += 1))}FixtureParity`,
    call: () => `call_${hex((call += 1))}FixtureParity`,
  };
}

type Ids = ReturnType<typeof createIds>;

function createClock() {
  let now = FIXTURE_T0;
  return {
    /** Advances the clock by `ms` and returns the new instant. */
    tick: (ms = 1_000) => (now += ms),
    now: () => now,
  };
}

type Clock = ReturnType<typeof createClock>;

function tokens(input: number, output: number, reasoning = 0, cacheRead = 0): FixtureTokens {
  return {
    total: input + output + reasoning + cacheRead,
    input,
    output,
    reasoning,
    cache: { read: cacheRead, write: 0 },
  };
}

// ─── Message builders ────────────────────────────────────────────────────────

interface Ctx {
  ids: Ids;
  clock: Clock;
  sessionID: string;
}

function userMessage(ctx: Ctx, build: (messageID: string) => FixturePart[]): FixtureMessageWithParts {
  const id = ctx.ids.message();
  const info: FixtureUserMessage = {
    id,
    sessionID: ctx.sessionID,
    role: 'user',
    time: { created: ctx.clock.tick(60_000) },
    agent: 'build',
    model: { ...MODEL },
  };
  return { info, parts: build(id) };
}

function textUserMessage(ctx: Ctx, text: string): FixtureMessageWithParts {
  return userMessage(ctx, (messageID) => [
    { id: ctx.ids.part(), sessionID: ctx.sessionID, messageID, type: 'text', text },
  ]);
}

interface AssistantOptions {
  parentID: string;
  /** Default true. False leaves `time.completed` unset (the message is streaming). */
  completed?: boolean;
  error?: FixtureMessageError;
  summary?: boolean;
  cost?: number;
  tokens?: FixtureTokens;
  mode?: string;
  finish?: string;
}

function assistantMessage(
  ctx: Ctx,
  options: AssistantOptions,
  build: (messageID: string) => FixturePart[],
): FixtureMessageWithParts {
  const id = ctx.ids.message();
  const created = ctx.clock.tick(2_000);
  const parts = build(id);
  const completed = options.completed ?? true;
  const info: FixtureAssistantMessage = {
    id,
    sessionID: ctx.sessionID,
    role: 'assistant',
    time: completed ? { created, completed: ctx.clock.tick(1_500) } : { created },
    parentID: options.parentID,
    modelID: MODEL.modelID,
    providerID: MODEL.providerID,
    mode: options.mode ?? 'build',
    agent: options.mode ?? 'build',
    path: { ...PATH },
    cost: options.cost ?? 0.0124,
    tokens: options.tokens ?? tokens(18_420, 612, 240, 12_800),
  };
  if (options.error) info.error = options.error;
  if (options.summary) info.summary = true;
  const finish = options.finish ?? (completed && !options.error ? 'stop' : undefined);
  if (finish) info.finish = finish;
  return { info, parts };
}

function stepStart(ctx: Ctx, messageID: string, snapshot?: string): FixturePart {
  const part: FixtureStepStartPart = { id: ctx.ids.part(), sessionID: ctx.sessionID, messageID, type: 'step-start' };
  if (snapshot) part.snapshot = snapshot;
  return part;
}

function stepFinish(ctx: Ctx, messageID: string, reason: string, snapshot?: string): FixturePart {
  const part: FixtureStepFinishPart = {
    id: ctx.ids.part(),
    sessionID: ctx.sessionID,
    messageID,
    type: 'step-finish',
    reason,
    cost: 0.0062,
    tokens: tokens(9_210, 306, 120, 6_400),
  };
  if (snapshot) part.snapshot = snapshot;
  return part;
}

function reasoning(ctx: Ctx, messageID: string, text: string, finished = true): FixturePart {
  const start = ctx.clock.tick(400);
  return {
    id: ctx.ids.part(),
    sessionID: ctx.sessionID,
    messageID,
    type: 'reasoning',
    text,
    time: finished ? { start, end: ctx.clock.tick(3_200) } : { start },
  };
}

function text(ctx: Ctx, messageID: string, body: string): FixturePart {
  const start = ctx.clock.tick(300);
  return {
    id: ctx.ids.part(),
    sessionID: ctx.sessionID,
    messageID,
    type: 'text',
    text: body,
    time: { start, end: ctx.clock.tick(900) },
  };
}

// ─── Tool parts ──────────────────────────────────────────────────────────────

/** The streamed prefix of the input JSON a pending call has received so far. */
function pendingRaw(input: FixtureToolSpec['input']): string {
  const json = JSON.stringify(input);
  return json.length > 48 ? json.slice(0, 48) : json;
}

export function toolPart(
  ctx: Ctx,
  messageID: string,
  spec: FixtureToolSpec,
  status: FixtureToolStatus,
): FixtureToolPart {
  const base = {
    id: ctx.ids.part(),
    sessionID: ctx.sessionID,
    messageID,
    type: 'tool' as const,
    callID: ctx.ids.call(),
    tool: spec.tool,
  };
  const start = ctx.clock.tick(500);
  const end = start + (spec.durationMs ?? 1_200);
  switch (status) {
    case 'pending':
      return { ...base, state: { status: 'pending', input: {}, raw: pendingRaw(spec.input) } };
    case 'running': {
      const state: FixtureToolStateRunning = { status: 'running', input: spec.input, time: { start } };
      if (spec.runningTitle) state.title = spec.runningTitle;
      if (spec.runningMetadata) state.metadata = spec.runningMetadata;
      return { ...base, state };
    }
    case 'completed':
      ctx.clock.tick(spec.durationMs ?? 1_200);
      return {
        ...base,
        state: {
          status: 'completed',
          input: spec.input,
          output: spec.output,
          title: spec.title ?? '',
          metadata: spec.metadata ?? {},
          time: { start, end },
        },
      };
    case 'error':
      ctx.clock.tick(spec.durationMs ?? 1_200);
      return { ...base, state: { status: 'error', input: spec.input, error: spec.error, time: { start, end } } };
  }
}

function statesOf(spec: FixtureToolSpec): readonly FixtureToolStatus[] {
  return spec.states ?? ALL_STATES;
}

// ─── Child sessions ──────────────────────────────────────────────────────────

function buildChildSession(ids: Ids, spec: FixtureChildSessionSpec): FixtureMessageWithParts[] {
  const ctx: Ctx = { ids, clock: createClock(), sessionID: spec.id };
  const status = spec.status ?? 'completed';
  const prompt = textUserMessage(ctx, spec.prompt);
  const reply = assistantMessage(
    ctx,
    {
      parentID: prompt.info.id,
      completed: status !== 'running',
      mode: 'general',
      error: status === 'error' ? { name: 'UnknownError', data: { message: spec.error ?? 'Sub-agent failed.' } } : undefined,
    },
    (messageID) => {
      const parts: FixturePart[] = [stepStart(ctx, messageID)];
      for (const tool of spec.tools) parts.push(toolPart(ctx, messageID, tool, 'completed'));
      if (status === 'completed' && spec.reply) parts.push(text(ctx, messageID, spec.reply));
      if (status !== 'running') parts.push(stepFinish(ctx, messageID, status === 'error' ? 'error' : 'stop'));
      return parts;
    },
  );
  return [prompt, reply];
}

// ─── Turn builders ───────────────────────────────────────────────────────────

const LONG_USER_TEXT = [
  'Write up the advisory lock rollout for the team. @explore the queue code first, starting with @src/server/jobs/queue/claim.ts, and check the screenshot of the latency panel I attached.',
  '',
  'What the doc needs:',
  '- why we moved off Redis locks (duplicate runs, 17 a day at peak);',
  '- the exact rollout order per region, with the flag name;',
  '- a table of before/after claim latency from the dashboard export in `latency.csv`;',
  '- the failover math, so nobody asks again why takeover is bounded by the poll interval;',
  '- one diagram of the election loop and one of the failover sequence;',
  '- code samples in TypeScript and Python, since the enrichment worker is still Python.',
  '',
  'Keep it short enough to read on a phone. Link the Postgres docs rather than restating them. The runbook in `rollout-plan.md` is the source of truth for dates; the PDF is the incident review from August that started all this. If anything in the runbook disagrees with the code, trust the code and call the difference out at the top.',
].join('\n');

function fileTag(path: string, mime: string, filename: string): string {
  return `<file path="${path}" mime="${mime}" filename="${filename}">\nThis file has been uploaded and is available at the path above.\n</file>`;
}

function attachmentsTurn(ctx: Ctx): FixtureMessageWithParts[] {
  const uploads = [
    fileTag('/workspace/uploads/rollout-plan.md', 'text/markdown', 'rollout-plan.md'),
    fileTag('/workspace/uploads/incident-review-2026-08.pdf', 'application/pdf', 'incident-review-2026-08.pdf'),
    fileTag('/workspace/uploads/latency.csv', 'text/csv', 'latency.csv'),
  ].join('\n');
  const mention = '@explore';
  const user = userMessage(ctx, (messageID) => [
    { id: ctx.ids.part(), sessionID: ctx.sessionID, messageID, type: 'text', text: `${LONG_USER_TEXT}\n${uploads}` },
    {
      id: ctx.ids.part(),
      sessionID: ctx.sessionID,
      messageID,
      type: 'file',
      mime: 'image/png',
      filename: 'latency-panel.png',
      url: FIXTURE_IMAGE_DATA_URI,
    },
    {
      id: ctx.ids.part(),
      sessionID: ctx.sessionID,
      messageID,
      type: 'agent',
      name: 'explore',
      source: {
        value: mention,
        start: LONG_USER_TEXT.indexOf(mention),
        end: LONG_USER_TEXT.indexOf(mention) + mention.length,
      },
    },
  ]);
  const reply = assistantMessage(ctx, { parentID: user.info.id }, (messageID) => [
    stepStart(ctx, messageID, '4b825dc642cb6eb9a060e54bf8d69288fbee4904'),
    reasoning(
      ctx,
      messageID,
      '**Structuring the rollout doc.** The runbook and the code agree on the flag name, so the doc can lead with the summary, then steps, numbers, code, math, and the two diagrams.',
    ),
    text(ctx, messageID, FIXTURE_MARKDOWN_DOCUMENT),
    stepFinish(ctx, messageID, 'stop', '4b825dc642cb6eb9a060e54bf8d69288fbee4904'),
  ]);
  return [user, reply];
}

function settledToolTurn(ctx: Ctx, group: FixtureToolGroup): FixtureMessageWithParts[] {
  const user = textUserMessage(ctx, group.prompt);
  const calls = assistantMessage(ctx, { parentID: user.info.id, finish: 'tool-calls' }, (messageID) => {
    const parts: FixturePart[] = [stepStart(ctx, messageID), reasoning(ctx, messageID, group.reasoning)];
    for (const spec of group.specs) {
      const states = statesOf(spec);
      if (states.includes('completed')) parts.push(toolPart(ctx, messageID, spec, 'completed'));
      if (states.includes('error')) parts.push(toolPart(ctx, messageID, spec, 'error'));
    }
    parts.push(stepFinish(ctx, messageID, 'tool-calls'));
    return parts;
  });
  const summary = assistantMessage(ctx, { parentID: user.info.id }, (messageID) => [
    stepStart(ctx, messageID),
    text(ctx, messageID, group.summary),
    stepFinish(ctx, messageID, 'stop'),
  ]);
  return [user, calls, summary];
}

const PATCH_SPEC: FixtureToolSpec = {
  renderer: 'bash-tool.tsx',
  tool: 'bash',
  input: { command: 'pnpm --filter api test -- jobs/queue', description: 'Run the queue tests' },
  output: ' ✓ jobs/queue/claim.test.ts (6 tests) 412ms\n ✓ jobs/queue/leader.test.ts (4 tests) 1.02s\n\n Test Files  2 passed (2)\n      Tests  10 passed (10)',
  metadata: { exit: 0, description: 'Run the queue tests' },
  error: 'Command failed with exit code 1',
  durationMs: 4_100,
};

function internalsTurn(ctx: Ctx): FixtureMessageWithParts[] {
  const user = userMessage(ctx, (messageID) => [
    {
      id: ctx.ids.part(),
      sessionID: ctx.sessionID,
      messageID,
      type: 'text',
      text: 'Swap the Redis lock for the advisory lock helper, run the queue tests, and have a sub-agent review the diff.',
    },
    {
      id: ctx.ids.part(),
      sessionID: ctx.sessionID,
      messageID,
      type: 'subtask',
      prompt: 'Review the diff in src/server/jobs/queue for lock leaks across awaits.',
      description: 'Review lock helper diff',
      agent: 'explore',
      model: { ...MODEL },
      command: 'review',
    },
  ]);
  const reply = assistantMessage(ctx, { parentID: user.info.id }, (messageID) => [
    stepStart(ctx, messageID, '9f2c1e7a4b3d5c6e8f0a1b2c3d4e5f6a7b8c9d0e'),
    {
      id: ctx.ids.part(),
      sessionID: ctx.sessionID,
      messageID,
      type: 'retry',
      attempt: 1,
      error: {
        name: 'APIError',
        data: { message: 'Overloaded', statusCode: 529, isRetryable: true },
      },
      time: { created: ctx.clock.tick(800) },
    },
    reasoning(ctx, messageID, 'The claim path only touches `claim.ts`; the leader loop lives in `leader.ts`. Two files change, one is new.'),
    toolPart(ctx, messageID, PATCH_SPEC, 'completed'),
    {
      id: ctx.ids.part(),
      sessionID: ctx.sessionID,
      messageID,
      type: 'patch',
      hash: '1d7e4c9b2a8f6e3d5c0b9a8f7e6d5c4b3a2f1e0d',
      files: [
        '/workspace/acme-dashboard/src/server/jobs/queue/claim.ts',
        '/workspace/acme-dashboard/src/server/jobs/queue/leader.ts',
      ],
    },
    {
      id: ctx.ids.part(),
      sessionID: ctx.sessionID,
      messageID,
      type: 'snapshot',
      snapshot: '1d7e4c9b2a8f6e3d5c0b9a8f7e6d5c4b3a2f1e0d',
    },
    {
      id: ctx.ids.part(),
      sessionID: ctx.sessionID,
      messageID,
      type: 'file',
      mime: 'image/png',
      filename: 'claim-latency-after.png',
      url: FIXTURE_IMAGE_DATA_URI,
    },
    text(
      ctx,
      messageID,
      'Swapped the Redis lock for `tryLead` in `claim.ts` and added `leader.ts`. All **10** queue tests pass. The review sub-agent found no lock held across an `await`.',
    ),
    stepFinish(ctx, messageID, 'stop', '1d7e4c9b2a8f6e3d5c0b9a8f7e6d5c4b3a2f1e0d'),
  ]);
  return [user, reply];
}

const GATEWAY_ERROR_BODY = JSON.stringify({
  message: 'The model provider is overloaded. Every route for claude-sonnet-4-5 failed.',
  provider: 'anthropic',
  code: 'upstream_overloaded',
  suggestion: 'Retry in a minute, or switch to another model for this session.',
  upstream_status: 529,
  request_id: 'req_01J8Z3FIXTUREPARITY0001',
  attempt_failures: [
    {
      attempt: 1,
      provider: 'anthropic',
      route_model: 'claude-sonnet-4-5',
      resolved_model: 'claude-sonnet-4-5-20250929',
      stage: 'upstream',
      code: 'overloaded_error',
      message: 'Overloaded',
      status: 529,
    },
    {
      attempt: 2,
      provider: 'bedrock',
      route_model: 'claude-sonnet-4-5',
      resolved_model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      stage: 'upstream',
      code: 'ServiceUnavailableException',
      message: 'Service unavailable. Try again later.',
      status: 503,
    },
  ],
});

function errorTurns(ctx: Ctx): FixtureMessageWithParts[] {
  const out: FixtureMessageWithParts[] = [];

  const provider = textUserMessage(ctx, 'Draft the announcement for #eng-updates.');
  out.push(
    provider,
    assistantMessage(
      ctx,
      {
        parentID: provider.info.id,
        error: {
          name: 'APIError',
          data: {
            message: 'The model provider is overloaded. Every route for claude-sonnet-4-5 failed.',
            statusCode: 529,
            isRetryable: false,
            responseBody: GATEWAY_ERROR_BODY,
          },
        },
      },
      (messageID) => [
        stepStart(ctx, messageID),
        reasoning(ctx, messageID, 'Short announcement: what changed, the flag, and who to ping.'),
      ],
    ),
  );

  const credits = textUserMessage(ctx, 'Then post it to Slack.');
  out.push(
    credits,
    assistantMessage(
      ctx,
      {
        parentID: credits.info.id,
        error: {
          name: 'APIError',
          data: {
            message: 'Payment Required: Insufficient credits. Balance: $-0.06',
            statusCode: 402,
            isRetryable: false,
          },
        },
        cost: 0,
        tokens: tokens(0, 0),
      },
      () => [],
    ),
  );

  const usage = textUserMessage(ctx, 'Try again with the free model.');
  out.push(
    usage,
    assistantMessage(
      ctx,
      {
        parentID: usage.info.id,
        error: { name: 'UnknownError', data: { message: 'Free usage exceeded, subscribe to Go to keep working.' } },
        cost: 0,
        tokens: tokens(0, 0),
      },
      () => [],
    ),
  );
  return out;
}

const COMPACTION_SUMMARY = [
  '## Conversation summary',
  '',
  '- The job queue moved from Redis locks to Postgres advisory locks behind `JOBS_ADVISORY_LOCK=1`.',
  '- `claim.ts` calls `tryLead`; `leader.ts` owns the poll loop (5 s).',
  '- Queue tests pass (10/10). The rollout doc is written; the announcement failed on billing.',
  '- Open: remove the Redis client, enable `us-east-1` after 24 h.',
].join('\n');

function compactionTurn(ctx: Ctx): FixtureMessageWithParts[] {
  const request = userMessage(ctx, (messageID) => [
    { id: ctx.ids.part(), sessionID: ctx.sessionID, messageID, type: 'compaction', auto: true, overflow: true },
  ]);
  const summary = assistantMessage(
    ctx,
    { parentID: request.info.id, summary: true, mode: 'compaction', tokens: tokens(142_880, 1_204, 0, 96_000) },
    (messageID) => [stepStart(ctx, messageID), text(ctx, messageID, COMPACTION_SUMMARY), stepFinish(ctx, messageID, 'stop')],
  );
  return [request, summary];
}

const GREP_SPEC: FixtureToolSpec = {
  renderer: 'grep-tool.tsx',
  tool: 'grep',
  input: { pattern: 'redis\\.set\\(', path: '/workspace/acme-dashboard/src', include: '*.ts' },
  output:
    'Found 2 matches\n/workspace/acme-dashboard/src/server/cache/session.ts:\n  Line 41:   await redis.set(key, value, "PX", ttl);\n\n/workspace/acme-dashboard/src/server/jobs/legacy/lock.ts:\n  Line 12:   const ok = await redis.set(`lock:${name}`, id, "NX", "PX", 30_000);',
  error: 'grep failed',
  durationMs: 300,
};

function abortedTurns(ctx: Ctx): { messages: FixtureMessageWithParts[]; interruptedId: string } {
  const user = textUserMessage(ctx, 'Remove the Redis client everywhere.');
  const reply = assistantMessage(
    ctx,
    {
      parentID: user.info.id,
      error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } },
    },
    (messageID) => [
      stepStart(ctx, messageID),
      reasoning(ctx, messageID, 'Finding every Redis call site before deleting the client.'),
      toolPart(ctx, messageID, GREP_SPEC, 'completed'),
    ],
  );
  const interrupted = textUserMessage(ctx, 'Wait — keep the session cache on Redis, only drop the lock client.');
  return { messages: [user, reply, interrupted], interruptedId: interrupted.info.id };
}

interface WorkingTurn {
  messages: FixtureMessageWithParts[];
  userMessageId: string;
  questions: FixtureQuestionRequest[];
  permissions: FixturePermissionRequest[];
}

function workingTurn(ctx: Ctx, groups: readonly FixtureToolGroup[]): WorkingTurn {
  const user = textUserMessage(
    ctx,
    'Now wire the connectors, schedule the daily report, and re-run every tool so I can compare the in-flight rows.',
  );
  const first = assistantMessage(ctx, { parentID: user.info.id, finish: 'tool-calls' }, (messageID) => [
    stepStart(ctx, messageID),
    reasoning(ctx, messageID, 'Re-running every tool family; the first calls go out together.'),
    toolPart(ctx, messageID, GREP_SPEC, 'completed'),
    stepFinish(ctx, messageID, 'tool-calls'),
  ]);

  const questions: FixtureQuestionRequest[] = [];
  const permissions: FixturePermissionRequest[] = [];
  const live = assistantMessage(ctx, { parentID: user.info.id, completed: false }, (messageID) => {
    const parts: FixturePart[] = [
      stepStart(ctx, messageID),
      reasoning(
        ctx,
        messageID,
        '**Checking the in-flight calls.** Connectors first, since the trigger needs the Slack channel id, then the',
        false,
      ),
    ];
    for (const group of groups) {
      for (const spec of group.specs) {
        const states = statesOf(spec);
        if (states.includes('running')) {
          const part = toolPart(ctx, messageID, spec, 'running');
          parts.push(part);
          const isQuestion = spec.tool === 'question' && Array.isArray(spec.input.questions);
          if (isQuestion && questions.length === 0) {
            questions.push({
              id: 'que_FixtureParity0001',
              sessionID: ctx.sessionID,
              questions: spec.input.questions as FixtureQuestionRequest['questions'],
              tool: { messageID, callID: part.callID },
            });
          }
          if (spec.tool === 'bash' && permissions.length === 0) {
            const command = typeof spec.input.command === 'string' ? spec.input.command : 'bash';
            permissions.push({
              id: 'per_FixtureParity0001',
              sessionID: ctx.sessionID,
              permission: 'bash',
              patterns: [command],
              metadata: {},
              always: [command.split(' ')[0] + ' *'],
              tool: { messageID, callID: part.callID },
            });
          }
        }
        if (states.includes('pending')) parts.push(toolPart(ctx, messageID, spec, 'pending'));
      }
    }
    parts.push(
      {
        id: ctx.ids.part(),
        sessionID: ctx.sessionID,
        messageID,
        type: 'text',
        text: 'Slack and GitHub are connected. Scheduling the daily report for **09:00 UTC** now, then I will',
        time: { start: ctx.clock.tick(300) },
      },
    );
    return parts;
  });
  return { messages: [user, first, live], userMessageId: user.info.id, questions, permissions };
}

// ─── Assembly ────────────────────────────────────────────────────────────────

export function buildSessionFixture(groups: readonly FixtureToolGroup[] = FIXTURE_TOOL_GROUPS): SessionFixture {
  const ids = createIds();
  const ctx: Ctx = { ids, clock: createClock(), sessionID: FIXTURE_SESSION_ID };
  const messages: FixtureMessageWithParts[] = [];
  const queueStates: Record<string, FixtureQueueState> = {};

  messages.push(...attachmentsTurn(ctx));
  for (const group of groups) messages.push(...settledToolTurn(ctx, group));
  messages.push(...internalsTurn(ctx));
  messages.push(...errorTurns(ctx));
  messages.push(...compactionTurn(ctx));
  const aborted = abortedTurns(ctx);
  messages.push(...aborted.messages);
  queueStates[aborted.interruptedId] = 'interrupted';
  const working = workingTurn(ctx, groups);
  messages.push(...working.messages);
  const queued = textUserMessage(ctx, 'After that, open a PR with the doc and ping #eng-updates.');
  messages.push(queued);
  queueStates[queued.info.id] = 'queued';

  const childSessions: Record<string, FixtureMessageWithParts[]> = {};
  const childStatuses: Record<string, FixtureSessionStatus> = {};
  for (const group of groups) {
    for (const child of group.childSessions ?? []) {
      childSessions[child.id] = buildChildSession(ids, child);
      childStatuses[child.id] = child.status === 'running' ? { type: 'busy' } : { type: 'idle' };
    }
  }

  const coverage = new Map<string, FixtureToolCoverage>();
  for (const group of groups) {
    for (const spec of group.specs) {
      const key = `${spec.renderer} ${spec.tool}`;
      const entry = coverage.get(key) ?? { renderer: spec.renderer, tool: spec.tool, states: [] };
      for (const state of statesOf(spec)) if (!entry.states.includes(state)) entry.states.push(state);
      coverage.set(key, entry);
    }
  }

  return {
    sessionId: FIXTURE_SESSION_ID,
    title: FIXTURE_SESSION_TITLE,
    messages,
    childSessions,
    childStatuses,
    working: {
      userMessageId: working.userMessageId,
      status: { type: 'busy' },
      retryStatus: {
        type: 'retry',
        attempt: 2,
        message: 'The model provider is overloaded. Retrying with the next route.',
        next: FIXTURE_T0,
      },
    },
    queueStates,
    questions: working.questions,
    permissions: working.permissions,
    agentNames: [...FIXTURE_AGENT_NAMES],
    toolCoverage: [...coverage.values()],
  };
}

/** The fixture, built once. Hosts must treat it as read-only. */
export const SESSION_FIXTURE: SessionFixture = buildSessionFixture();
