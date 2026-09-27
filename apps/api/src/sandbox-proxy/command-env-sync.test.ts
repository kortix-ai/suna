// `POST /session/:id/command` is opencode's BLOCKING slash-command endpoint: it
// creates a user message and runs a full agent turn, exactly like a prompt does.
// It therefore needs the same PRE-PROMPT project-env sync a prompt gets, and for
// the same reasons — the grant that scopes which secrets the box may read is
// re-resolved there, and it is the only self-heal for a box that missed a secret
// propagation (`propagateProjectSecretsToActiveSandboxes` targets ACTIVE rows
// only, so a box stopped at write time never receives it).
//
// Commit 27279d2232 already made `/command` non-idempotent for retry/dedupe
// (`isNonIdempotentSessionWrite`). This file pins the third question — "should
// this get the pre-prompt env sync?" — and the exact set of sub-steps that run.
//
// NO `mock.module` ANYWHERE IN THIS FILE, on purpose. Bun's `mock.module` is
// PROCESS-wide and does not unwind at a file boundary, so a stub here silently
// replaces the real module for every sibling suite that runs after this one in
// the same process. An earlier draft of this file stubbed `./backend` and turned
// 4 unrelated cases in backend.test.ts / wake-deadline-guard.test.ts red, their
// spies never firing (`Received: 0`). Everything below is either a pure function
// called directly, or `runPrePromptEnvSync` with its collaborators passed in.
//
// AND NO IMPORT OF `./routes/preview`, for the mirror-image reason: the module
// registry is process-wide too, so importing the route here CACHED it with its
// real collaborators before any sibling could register its `mock.module` stubs —
// which silently disabled them. Measured: preview-connector-required.test.ts is
// 13 pass / 0 fail alone but was 27 / 3 when this file loaded first, and the
// three casualties were its Idempotency-Key-burn cases. Import the extracted
// ../sandbox-proxy/pre-prompt-env-sync module, which binds no mocked module.
import { describe, expect, test } from 'bun:test';
import { SecretGrantResolutionError } from '../projects/lib/secret-grant';
import { SessionGrantRemintError } from '../projects/lib/session-token-grant';
import {
  type PrePromptEnvSyncDeps,
  bodyWithoutPromptAgent,
  requestedPromptAgent,
  isTurnStartEnvSync,
  runPrePromptEnvSync,
} from './pre-prompt-env-sync';

const RECORD = {
  accountId: 'acct-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  externalId: 'ext-1',
  agentName: 'default',
  provider: 'daytona',
};

function jsonHeaders(): Headers {
  return new Headers({ 'content-type': 'application/json' });
}

function encode(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
}

// The real shape of an opencode slash-command body: `{command, arguments, agent,
// model, variant}` — NOT `{parts}`. See SessionCommandData in
// @opencode-ai/sdk/dist/v2/gen/types.gen.d.ts.
const COMMAND_BODY = encode({
  command: 'webapp',
  arguments: 'build a landing page',
  agent: 'writer',
  model: 'anthropic/claude-sonnet-4',
  variant: 'default',
});

type Recorder = {
  deps: PrePromptEnvSyncDeps;
  envSync: Array<{ requestedAgent?: string | null; sessionId: string; providerName: string }>;
  remint: Array<{ sessionAgent: string; requestedAgent: string | null }>;
  snapshot: Array<{ sessionId: string; projectId: string; externalId: string; userId?: string }>;
  titles: string[];
};

/** Collaborators as plain recording fakes — passed in, never module-patched. */
function recorder(opts: { envSyncError?: () => Error } = {}): Recorder {
  const rec: Recorder = {
    envSync: [],
    remint: [],
    snapshot: [],
    titles: [],
    deps: {} as PrePromptEnvSyncDeps,
  };
  rec.deps = {
    syncEnv: (async (args) => {
      rec.envSync.push({
        requestedAgent: args.requestedAgent,
        sessionId: args.sessionId,
        providerName: args.providerName,
      });
      if (opts.envSyncError) throw opts.envSyncError();
    }) as PrePromptEnvSyncDeps['syncEnv'],
    remintGrant: (async (input) => {
      rec.remint.push({ sessionAgent: input.sessionAgent, requestedAgent: input.requestedAgent });
      return { action: 'skip' };
    }) as PrePromptEnvSyncDeps['remintGrant'],
    scheduleSnapshot: ((input) => {
      rec.snapshot.push({
        sessionId: input.sessionId,
        projectId: input.projectId,
        externalId: input.externalId,
        userId: input.userId,
      });
    }) as PrePromptEnvSyncDeps['scheduleSnapshot'],
    generateTitle: (async (input) => {
      rec.titles.push(input.firstPromptText);
    }) as PrePromptEnvSyncDeps['generateTitle'],
  };
  return rec;
}

function runSync(rec: Recorder, body: ArrayBuffer, requestedAgent: string | null = 'writer') {
  return runPrePromptEnvSync(
    {
      record: RECORD,
      sandboxId: 'sb-1',
      port: 8000,
      userId: 'u1',
      origin: 'http://app.local',
      previewUrl: 'http://sandbox.local',
      providerHeaders: {},
      serviceKey: 'svc-key',
      requestedAgent,
      body,
      incomingHeaders: jsonHeaders(),
    },
    rec.deps,
  );
}

describe('isTurnStartEnvSync', () => {
  test('matches every endpoint that starts a user turn, /command included', () => {
    for (const [method, path] of [
      ['POST', '/session/abc123/prompt_async'],
      ['POST', '/session/abc123/message'],
      ['POST', '/session/abc123/command'],
      ['POST', '/session/abc-123/command?x=1'],
      ['post', '/session/abc123/command'],
    ]) {
      expect(isTurnStartEnvSync(8000, method, path)).toBe(true);
    }
  });

  test('ignores reads, other ports, and lookalike paths', () => {
    expect(isTurnStartEnvSync(8000, 'GET', '/session/abc123/command')).toBe(false);
    expect(isTurnStartEnvSync(3000, 'POST', '/session/abc123/command')).toBe(false);
    expect(isTurnStartEnvSync(8000, 'POST', '/session/abc123/commands')).toBe(false);
    expect(isTurnStartEnvSync(8000, 'POST', '/not-session/abc/command')).toBe(false);
    expect(isTurnStartEnvSync(8000, 'POST', '/session/abc123/shell')).toBe(false);
  });

  // Deliberate boundary, not an oversight: /summarize is COMPACTION, not a user
  // prompt. It carries no `agent` to re-scope the grant for and no secrets the
  // user just changed, and blocking a compaction on a secret-grant refusal would
  // wedge a session instead of protecting it. `isTurnStartRequest` covers it for
  // deadline accounting; the env sync deliberately does not.
  test('does NOT match /summarize, on either port and behind the in-box prefix', () => {
    expect(isTurnStartEnvSync(8000, 'POST', '/session/abc123/summarize')).toBe(false);
    expect(isTurnStartEnvSync(4096, 'POST', '/session/abc123/summarize')).toBe(false);
    expect(isTurnStartEnvSync(8000, 'POST', '/proxy/4096/session/abc123/summarize')).toBe(false);
  });

  // THE HOLE THIS CLOSES. `shouldSyncProjectEnvBeforeProxy` answered `port !== 8000
  // ⇒ false` on the CLIENT-addressed port and never stripped the in-box
  // `/proxy/<n>/` prefix. Daytona's `routeIngress` is a pass-through, so a prompt
  // addressed at :4096 kept `port === 4096` and skipped the secret refresh and the
  // grant re-mint while still getting the config convergence, which keys on
  // `isTurnStartRequest`. Both OpenCode halves count: a verified reload swaps
  // which one is live.
  test('covers both OpenCode halves and the in-box /proxy/<n>/ prefix', () => {
    expect(isTurnStartEnvSync(4096, 'POST', '/session/abc123/prompt_async')).toBe(true);
    expect(isTurnStartEnvSync(4097, 'POST', '/session/abc123/message')).toBe(true);
    expect(isTurnStartEnvSync(8000, 'POST', '/proxy/4096/session/abc123/message')).toBe(true);
    expect(isTurnStartEnvSync(4096, 'POST', '/proxy/4097/session/abc123/command')).toBe(true);
  });
});

describe('the /command body sub-steps', () => {
  test('the requested agent is read from a command body just like a prompt body', () => {
    expect(requestedPromptAgent(COMMAND_BODY, jsonHeaders())).toBe('writer');
    expect(requestedPromptAgent(encode({ command: 'webapp', arguments: 'x' }), jsonHeaders())).toBe(
      null,
    );
  });

  test("the legacy 'default' sentinel is stripped and the rest of the command survives", () => {
    const rewritten = bodyWithoutPromptAgent(
      encode({ command: 'webapp', arguments: 'go', agent: 'default', variant: 'v2' }),
      jsonHeaders(),
    );
    const parsed = JSON.parse(new TextDecoder().decode(rewritten));
    expect('agent' in parsed).toBe(false);
    expect(parsed).toEqual({ command: 'webapp', arguments: 'go', variant: 'v2' });
  });

});

describe('runPrePromptEnvSync — a /command body', () => {
  test('syncs the project env, scoped to the agent the command runs', async () => {
    const rec = recorder();
    expect(await runSync(rec, COMMAND_BODY)).toBe(null);
    expect(rec.envSync).toEqual([
      { requestedAgent: 'writer', sessionId: 'sess-1', providerName: 'daytona' },
    ]);
  });

  test('re-mints the session grant for the agent the command switches to', async () => {
    const rec = recorder();
    await runSync(rec, COMMAND_BODY);
    expect(rec.remint).toEqual([{ sessionAgent: 'default', requestedAgent: 'writer' }]);
  });

  // REGRESSION (staging release gate, SESS-10): the schedule used to omit
  // `userId`. The daemon 401s every non-`/kortix/*` path without the user
  // context that only a userId mints, so the refresh degraded to `unreachable`
  // and never wrote a snapshot.
  test('schedules the opencode snapshot refresh as the caller', async () => {
    const rec = recorder();
    await runSync(rec, COMMAND_BODY);
    expect(rec.snapshot).toEqual([
      { sessionId: 'sess-1', projectId: 'proj-1', externalId: 'ext-1', userId: 'u1' },
    ]);
  });

  test('generates NO session title from a command body', async () => {
    const rec = recorder();
    await runSync(rec, COMMAND_BODY);
    // The REAL `extractPromptInfo` runs here — it reads `parts[].text`, and a
    // command body has no `parts`. Skipped, not crashed: the call above resolved
    // and the env sync below it still ran.
    expect(rec.titles).toEqual([]);
    expect(rec.envSync).toHaveLength(1);
  });

  test('a command carrying FILE parts still generates no title', async () => {
    const rec = recorder();
    await runSync(
      rec,
      encode({
        command: 'webapp',
        arguments: 'use this',
        parts: [{ type: 'file', mime: 'image/png', url: 'https://x/y.png' }],
      }),
    );
    expect(rec.titles).toEqual([]);
    expect(rec.envSync).toHaveLength(1);
  });

  // The control: the same function on a real prompt body DOES title the session,
  // so the empty `titles` above is a property of the command body, not of the
  // fake. Without this a broken `generateTitle` fake would pass every case above.
  test('a prompt body in the same call path DOES generate a title', async () => {
    const rec = recorder();
    await runSync(rec, encode({ parts: [{ type: 'text', text: 'build me a site' }] }), null);
    expect(rec.titles).toEqual(['build me a site']);
  });
});

describe('runPrePromptEnvSync — refusals and retries', () => {
  test('an unresolvable grant refuses the turn with 503', async () => {
    const rec = recorder({
      envSyncError: () =>
        new SecretGrantResolutionError('writer', new Error('manifest unreadable')),
    });
    const refusal = await runSync(rec, COMMAND_BODY);
    expect(refusal?.status).toBe(503);
    expect(await refusal?.json()).toMatchObject({ code: 'AGENT_SECRET_GRANT_UNRESOLVED' });
    // Refused BEFORE the grant re-mint — one switch never half-applies.
    expect(rec.remint).toEqual([]);
  });

  // A differing grant is no longer a refusal: the env is re-scoped onto the
  // agent that runs. A re-mint that cannot apply is a 5xx "could not apply",
  // never a permanent 409 telling the user to start a new session.
  test('a grant re-mint that cannot apply refuses with 503, not 409', async () => {
    const rec = recorder({
      envSyncError: () => new SessionGrantRemintError('ses_1', new Error('db down')),
    });
    const refusal = await runSync(rec, COMMAND_BODY);
    expect(refusal?.status).toBe(503);
    expect(await refusal?.json()).toMatchObject({ code: 'AGENT_SWITCH_GRANT_UNAPPLIED' });
  });
});

// The 502 for a non-retryable env-sync failure and the retry of a transient
// one are proven at the HTTP route in __tests__/e2e-preview-proxy.test.ts.
