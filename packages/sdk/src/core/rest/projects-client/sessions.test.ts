import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { clearSessionFresh, isSessionFresh } from '../../http/fresh-sessions';
import type {
  CreateProjectSessionInput,
  ProjectSession,
  RemovedSessionPrompt,
  SessionPrompt,
  SessionTurn,
  SessionTurnStatus,
} from './sessions';
import {
  createProjectSession,
  createSessionPrompt,
  createSessionPublicShare,
  claimWarmProjectSession,
  deleteProjectSession,
  deleteSessionPrompt,
  ensureWarmProjectSession,
  getProjectSession,
  getProjectSessionConfigState,
  getProjectSessionScope,
  getSessionAudit,
  getSessionPreviewCandidates,
  getSessionOpenBundle,
  getSessionTranscript,
  getSessionTurn,
  listProjectSessions,
  listSessionPrompts,
  listSessionPublicShares,
  reloadProjectSessionConfig,
  reloadProjectSessionConfigStream,
  restartProjectSession,
  holdSessionPrompts,
  retrySessionPrompt,
  revokeSessionPublicShare,
  setProjectSessionScope,
  setProjectSessionSharing,
  stopProjectSession,
  updateProjectSession,
} from './sessions';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

type IsNever<T> = [T] extends [never] ? true : false;
type SessionAttributionKey<T> = Extract<keyof T, `${'end_user' | 'origin'}_${'ref'}`>;

test('listProjectSessions hits GET /projects/:id/sessions', async () => {
  nextResponse = { status: 200, body: [] };
  const result = await listProjectSessions('P1');
  expect(last().url).toContain('/projects/P1/sessions');
  expect(last().method).toBe('GET');
  expect(result).toEqual([]);
});

test('listProjectSessions requests the manager-only project inventory scope', async () => {
  nextResponse = { status: 200, body: [] };
  await listProjectSessions('P1', { scope: 'project' });
  expect(last().url).toContain('/projects/P1/sessions?scope=project');
  expect(last().method).toBe('GET');
});

test('listProjectSessions keeps can_manage_sharing and can_manage_lifecycle apart', async () => {
  // Two different verdicts. `can_manage_sharing` answers "may I change who can
  // open this session" — the owner's call. `can_manage_lifecycle` answers "may
  // I stop/restart/delete it" — owner or project manager. A project manager
  // looking at somebody else's session gets false and true respectively, and a
  // client that reads one for the other either hides a control it should show
  // or shows one the API will 403.
  nextResponse = {
    status: 200,
    body: [
      {
        session_id: 'S1',
        is_owner: false,
        can_manage_sharing: false,
        can_manage_lifecycle: true,
      },
    ],
  };
  const [session] = await listProjectSessions('P1');
  expect(session.can_manage_sharing).toBe(false);
  expect(session.can_manage_lifecycle).toBe(true);
});

test('listProjectSessions throws when the response is unsuccessful', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(listProjectSessions('P1')).rejects.toBeTruthy();
});

test('setProjectSessionSharing PUTs the sharing intent', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1' } };
  await setProjectSessionSharing('P1', 'S1', { mode: 'project' });
  expect(last().url).toContain('/projects/P1/sessions/S1/sharing');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ mode: 'project' });
});

test('getSessionPreviewCandidates hits the previews endpoint', async () => {
  nextResponse = { status: 200, body: { candidates: [] } };
  const result = await getSessionPreviewCandidates('P1', 'S1');
  expect(last().url).toContain('/projects/P1/sessions/S1/previews');
  expect(result).toEqual({ candidates: [] });
});

test('listSessionPublicShares hits GET /public-shares with showErrors: false', async () => {
  nextResponse = { status: 200, body: { shares: [] } };
  const result = await listSessionPublicShares('P1', 'S1');
  expect(last().url).toContain('/projects/P1/sessions/S1/public-shares');
  expect(result).toEqual({ shares: [] });
});

test('createSessionPublicShare POSTs the share input', async () => {
  nextResponse = { status: 200, body: { share: { share_id: 'SH1' } } };
  const input = { preview_id: 'prev-1', mode: 'view' as const };
  const result = await createSessionPublicShare('P1', 'S1', input);
  expect(last().url).toContain('/projects/P1/sessions/S1/public-shares');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual(input);
  expect(result.share.share_id).toBe('SH1');
});

test('revokeSessionPublicShare DELETEs the specific share', async () => {
  nextResponse = { status: 200, body: { share: { share_id: 'SH1' } } };
  await revokeSessionPublicShare('P1', 'S1', 'SH1');
  expect(last().url).toContain('/projects/P1/sessions/S1/public-shares/SH1');
  expect(last().method).toBe('DELETE');
});

test('createProjectSession POSTs the input and marks the new session fresh', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-1', name: null } };
  const result = await createProjectSession('P1', { base_ref: 'main' });
  expect(last().url).toContain('/projects/P1/sessions');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ base_ref: 'main' });
  expect((result as any).session_id).toBe('NEW-1');
  expect(isSessionFresh('NEW-1')).toBe(true);
});

test('createProjectSession serializes non-secret runtime_context unchanged', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-CONTEXT', name: null } };
  await createProjectSession('P1', {
    runtime_context: {
      workspace_id: 'org_123',
      locale: 'fr',
      licensed: true,
      risk_score: 0.5,
      optional: null,
    },
  });
  expect(last().body).toEqual({
    runtime_context: {
      workspace_id: 'org_123',
      locale: 'fr',
      licensed: true,
      risk_score: 0.5,
      optional: null,
    },
  });
});

test('createProjectSession serializes canonical connection bindings', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-BINDING', name: null } };
  await createProjectSession('P1', {
    connector_bindings: {
      gmail: { connection_id: 'AUTH-1' },
    },
  });
  expect(last().body).toEqual({
    connector_bindings: {
      gmail: { connection_id: 'AUTH-1' },
    },
  });
});

test('createProjectSession does NOT mark the session fresh when an initial_prompt is set', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-2', name: null } };
  await createProjectSession('P1', { initial_prompt: 'hello' });
  expect(isSessionFresh('NEW-2')).toBe(false);
});

test('createProjectSession defaults the body to {} when no input is given', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-3' } };
  await createProjectSession('P1');
  expect(last().body).toEqual({});
});

test('ensureWarmProjectSession POSTs the server-owned warm-session request', async () => {
  nextResponse = {
    status: 200,
    body: {
      session: { session_id: 'WARM-1' },
      reused: true,
      workspace_refresh: { status: 'unchanged' },
    },
  };
  const result = await ensureWarmProjectSession('P1');
  expect(last().url).toBe('http://test.local/projects/P1/sessions/warm');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result.session.session_id).toBe('WARM-1');
  expect(result.reused).toBe(true);
});

test('ensureWarmProjectSession does NOT mark a REUSED session fresh — a reused session is by definition not fresh', async () => {
  clearSessionFresh('WARM-REUSED-1');
  nextResponse = {
    status: 200,
    body: {
      session: { session_id: 'WARM-REUSED-1' },
      reused: true,
      workspace_refresh: { status: 'unchanged' },
    },
  };
  await ensureWarmProjectSession('P1');
  expect(isSessionFresh('WARM-REUSED-1')).toBe(false);
});

test('ensureWarmProjectSession marks a freshly-created session fresh (reused: false)', async () => {
  clearSessionFresh('WARM-NEW-1');
  nextResponse = {
    status: 200,
    body: {
      session: { session_id: 'WARM-NEW-1' },
      reused: false,
      workspace_refresh: { status: 'unchanged' },
    },
  };
  await ensureWarmProjectSession('P1');
  expect(isSessionFresh('WARM-NEW-1')).toBe(true);
});

test('ensureWarmProjectSession forwards exclude_session_id in the request body when given', async () => {
  nextResponse = {
    status: 200,
    body: {
      session: { session_id: 'WARM-2' },
      reused: false,
      workspace_refresh: { status: 'skipped' },
    },
  };
  await ensureWarmProjectSession('P1', { excludeSessionId: 'JUST-TAKEN-1' });
  expect(last().body).toEqual({ exclude_session_id: 'JUST-TAKEN-1' });
});

test('ensureWarmProjectSession omits exclude_session_id when not given', async () => {
  nextResponse = {
    status: 200,
    body: {
      session: { session_id: 'WARM-3' },
      reused: false,
      workspace_refresh: { status: 'skipped' },
    },
  };
  await ensureWarmProjectSession('P1', {});
  expect(last().body).toEqual({});
});

test('ensureWarmProjectSession keeps a declined warm session out of the global error sink', async () => {
  const onError = mock(() => {});
  configureKortix({
    backendUrl: 'http://test.local',
    getToken: async () => 'tok',
    onError,
  });
  nextResponse = {
    status: 409,
    body: {
      error: 'This project cannot prepare a warm session right now.',
      code: 'WARM_SESSION_UNAVAILABLE',
    },
  };

  try {
    await expect(ensureWarmProjectSession('P1')).rejects.toMatchObject({
      status: 409,
      code: 'WARM_SESSION_UNAVAILABLE',
    });
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});

test('claimWarmProjectSession POSTs the selected warm session and create options', async () => {
  nextResponse = { status: 200, body: { session_id: 'WARM-1' } };
  const result = await claimWarmProjectSession('P1', {
    session_id: 'WARM-1',
    agent_name: 'reviewer',
    sandbox_slug: 'large',
  });
  expect(last().url).toBe('http://test.local/projects/P1/sessions/warm/claim');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({
    session_id: 'WARM-1',
    agent_name: 'reviewer',
    sandbox_slug: 'large',
  });
  expect(result.session_id).toBe('WARM-1');
});

test('claimWarmProjectSession keeps recoverable claim conflicts out of the global error sink', async () => {
  const onError = mock(() => {});
  configureKortix({
    backendUrl: 'http://test.local',
    getToken: async () => 'tok',
    onError,
  });
  nextResponse = {
    status: 409,
    body: {
      message: 'The warm session does not match the selected agent or sandbox',
      code: 'WARM_SESSION_CONFIGURATION_MISMATCH',
    },
  };

  try {
    await expect(
      claimWarmProjectSession('P1', {
        session_id: 'WARM-1',
        agent_name: 'reviewer',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'WARM_SESSION_CONFIGURATION_MISMATCH',
    });
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});

test('getProjectSession hits GET /projects/:id/sessions/:sid and forwards showErrors', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1' } };
  await getProjectSession('P1', 'S1', { showErrors: false });
  expect(last().url).toContain('/projects/P1/sessions/S1');
  expect(last().method).toBe('GET');
});

test('getSessionAudit appends ?limit= only when a limit is given', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1', agent: null, count: 0, actions: [] } };
  await getSessionAudit('P1', 'S1', 10);
  expect(last().url).toContain('/projects/P1/sessions/S1/audit?limit=10');

  await getSessionAudit('P1', 'S1');
  expect(last().url).toBe('http://test.local/projects/P1/sessions/S1/audit');
});

test('getSessionAudit can poll approvals without refetching historical events', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1', agent: null, count: 0, actions: [] } };
  await getSessionAudit('P1', 'S1', 1000, {
    cursor: '14|event-14',
    includeEvents: false,
    showErrors: false,
  });
  expect(last().url).toBe(
    'http://test.local/projects/P1/sessions/S1/audit?limit=1000&cursor=14%7Cevent-14&include_events=false',
  );
});

test('getSessionTranscript builds the query string from limit/chars options', async () => {
  nextResponse = {
    status: 200,
    body: {
      available: true,
      reason: null,
      opencode_session_id: 'ocs-1',
      message_count: 0,
      messages: [],
    },
  };
  await getSessionTranscript('P1', 'S1', { limit: 5, chars: 200 });
  expect(last().url).toContain('/projects/P1/sessions/S1/transcript?limit=5&chars=200');

  await getSessionTranscript('P1', 'S1');
  expect(last().url).toBe('http://test.local/projects/P1/sessions/S1/transcript');
});

test('getSessionTurn hits GET /projects/:id/sessions/:id/turn', async () => {
  nextResponse = { status: 200, body: { turns: [] } };
  await getSessionTurn('P1', 'S1');
  expect(last().url).toBe('http://test.local/projects/P1/sessions/S1/turn');
  expect(last().method).toBe('GET');
});

// The wire keys are snake_case and this reader hands them through UNTRANSLATED.
// Deep equality is the point: every other payload on the session surface is
// snake_case, and these names are a published type, so a later camelCase
// "tidy-up" would be a breaking change for every installed consumer.
test('getSessionTurn returns a live turn verbatim', async () => {
  // Typed, not inferred: the annotation is a second assertion — it fails to
  // compile if a field is renamed, dropped, or retyped on the published shape.
  const turn: SessionTurn = {
    turn_token: 't1',
    state: 'active',
    message_id: 'msg_1',
    opencode_session_id: 'ses_root',
    started_at: '2026-08-17T00:00:00.000Z',
    accepted_at: '2026-08-17T00:00:01.000Z',
  };
  nextResponse = { status: 200, body: { turns: [turn] } satisfies SessionTurnStatus };
  const result = await getSessionTurn('P1', 'S1');
  expect(result).toEqual({ turns: [turn] });
});

// `turns` is a LIST because a session really can hold two open turns at once —
// a trigger delivery and a web prompt land as separate tokens. A reader that
// collapsed them would report the older one as not running, which is the
// phantom-idle this endpoint exists to end.
test('getSessionTurn carries every concurrent turn through', async () => {
  const turns: SessionTurn[] = [
    {
      turn_token: 't-web',
      state: 'delivering',
      message_id: 'msg_B',
      opencode_session_id: null,
      started_at: '2026-08-17T12:00:02.000Z',
      accepted_at: null,
    },
    {
      turn_token: 't-trigger',
      state: 'active',
      message_id: 'msg_A',
      opencode_session_id: 'ses_root',
      started_at: '2026-08-17T12:00:00.000Z',
      accepted_at: '2026-08-17T12:00:00.400Z',
    },
  ];
  nextResponse = { status: 200, body: { turns } satisfies SessionTurnStatus };
  const result = await getSessionTurn('P1', 'S1');
  expect(result.turns).toEqual(turns);
});

test('getSessionTurn surfaces last_ended when nothing is running', async () => {
  nextResponse = {
    status: 200,
    body: {
      turns: [],
      last_ended: {
        turn_token: 't0',
        end_reason: 'runtime_gone',
        ended_at: '2026-08-17T00:00:09.000Z',
      },
    } satisfies SessionTurnStatus,
  };
  const result = await getSessionTurn('P1', 'S1');
  expect(result.turns).toEqual([]);
  expect(result.last_ended).toEqual({
    turn_token: 't0',
    end_reason: 'runtime_gone',
    ended_at: '2026-08-17T00:00:09.000Z',
  });
});

// The whole reason `last_ended` is OPTIONAL rather than nullable: its absence is
// what separates "this session has never run a turn" from "the last one just
// finished", and a caller cannot make that call from an empty `turns` alone.
test('getSessionTurn distinguishes a session that never ran a turn', async () => {
  nextResponse = { status: 200, body: { turns: [] } satisfies SessionTurnStatus };
  const result = await getSessionTurn('P1', 'S1');
  expect(result.turns).toEqual([]);
  expect(result.last_ended).toBeUndefined();
});

test('getSessionTurn throws on a failed request', async () => {
  nextResponse = { status: 404, body: { error: 'Not found' } };
  expect(getSessionTurn('P1', 'S1')).rejects.toThrow();
});

test('updateProjectSession PATCHes the name/metadata input', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1', name: 'Renamed' } };
  await updateProjectSession('P1', 'S1', { name: 'Renamed' });
  expect(last().url).toContain('/projects/P1/sessions/S1');
  expect(last().method).toBe('PATCH');
  expect(last().body).toEqual({ name: 'Renamed' });
});

test('deleteProjectSession DELETEs the session', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteProjectSession('P1', 'S1');
  expect(last().url).toContain('/projects/P1/sessions/S1');
  expect(last().method).toBe('DELETE');
});

test('restartProjectSession POSTs to /restart', async () => {
  nextResponse = { status: 200, body: { ok: true, session_id: 'S1', status: 'provisioning' } };
  const result = await restartProjectSession('P1', 'S1');
  expect(last().url).toContain('/projects/P1/sessions/S1/restart');
  expect(last().method).toBe('POST');
  expect(result.status).toBe('provisioning');
});

test('getProjectSessionConfigState GETs /config', async () => {
  nextResponse = {
    status: 200,
    body: {
      base_ref: 'main',
      running_etag: 'aaaaaaaaaaaaaaaa',
      latest_etag: 'bbbbbbbbbbbbbbbb',
      commit_sha: 'c'.repeat(40),
      stale: true,
      sandbox_reachable: true,
    },
  };
  const result = await getProjectSessionConfigState('P1', 'S1');
  expect(last().url).toContain('/projects/P1/sessions/S1/config');
  expect(last().method).toBe('GET');
  expect(result.stale).toBe(true);
  expect(result.latest_etag).toBe('bbbbbbbbbbbbbbbb');
});

test('getProjectSessionConfigState preserves a NULL stale — "could not tell" is not "fresh"', async () => {
  // The whole point of the tri-state. A client that coerces this to false
  // reports a session as up to date when nobody ever asked the box.
  nextResponse = {
    status: 200,
    body: {
      base_ref: 'main',
      running_etag: null,
      latest_etag: null,
      commit_sha: null,
      stale: null,
      sandbox_reachable: false,
    },
  };
  const result = await getProjectSessionConfigState('P1', 'S1');
  expect(result.stale).toBeNull();
  expect(result.stale).not.toBe(false);
});

test('reloadProjectSessionConfig POSTs to /reload with an empty body by default', async () => {
  nextResponse = {
    status: 200,
    body: {
      applied: true,
      previous_etag: 'aaaaaaaaaaaaaaaa',
      etag: 'bbbbbbbbbbbbbbbb',
      repo_refreshed: true,
      commit_sha: 'c'.repeat(40),
      detail: 'Reloaded. The next prompt runs the new config.',
    },
  };
  const result = await reloadProjectSessionConfig('P1', 'S1');
  expect(last().url).toContain('/projects/P1/sessions/S1/reload');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result.applied).toBe(true);
});

test('reloadProjectSessionConfig surfaces whether the agent files actually changed', async () => {
  // `applied` says the compiled config was pushed. `config_dir_synced` says
  // whether the files opencode READS were brought forward — and those came
  // apart in production: applied:true with the agent still on the old prompt.
  nextResponse = {
    status: 200,
    body: {
      applied: true,
      previous_etag: 'aaaaaaaaaaaaaaaa',
      etag: 'bbbbbbbbbbbbbbbb',
      repo_refreshed: true,
      commit_sha: null,
      agent_files: 'kept-yours',
      detail: 'Config pushed, but this session has committed its own agent changes…',
    },
  };
  const result = await reloadProjectSessionConfig('P1', 'S1');
  expect(result.applied).toBe(true);
  expect(result.agent_files).toBe('kept-yours');
});

test('"we did not find out" is distinguishable from "we declined"', async () => {
  // Three different things that a boolean collapsed: an old daemon that could
  // not answer, a caller that never asked, and a deliberate refusal. Telling a
  // --no-repo caller their sandbox "could not confirm" is a fabrication.
  for (const agent_files of ['unknown', 'not-requested', 'kept-yours'] as const) {
    nextResponse = { status: 200, body: { applied: true, detail: 'ok', agent_files } };
    expect((await reloadProjectSessionConfig('P1', 'S1')).agent_files).toBe(agent_files);
  }
});

test('reloadProjectSessionConfig forwards force as a real boolean', async () => {
  // The route tests `body?.force === true` — a truthy string would be ignored
  // and the reload would silently refuse again on a busy session.
  nextResponse = { status: 200, body: { applied: true, detail: 'ok' } };
  await reloadProjectSessionConfig('P1', 'S1', { force: true });
  expect(last().body).toEqual({ force: true });
});

test('neither config call routes failures to the host global error handler', async () => {
  // `showErrors` defaults to TRUE, which calls platformConfig().onError — a
  // toast in the web host. Both of these must opt out, for different reasons:
  // the GET is a background probe that 404s on any still-materializing session
  // (so the default toasts at a user who merely opened one, on every focus),
  // and the POST's 409 is a question the caller answers with a confirm dialog,
  // not an error to announce over it.
  const errors: unknown[] = [];
  configureKortix({
    backendUrl: 'http://test.local',
    getToken: async () => 'tok',
    onError: (err: unknown) => errors.push(err),
  });

  nextResponse = { status: 404, body: { error: 'Not found' } };
  await getProjectSessionConfigState('P1', 'S1').catch(() => {});
  nextResponse = { status: 409, body: { code: 'SESSION_BUSY', reason: 'session is mid-turn' } };
  await reloadProjectSessionConfig('P1', 'S1').catch(() => {});

  expect(errors).toEqual([]);

  // Leave the shared config as the rest of this file expects it.
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
});

test('reloadProjectSessionConfig surfaces the 409 code and reason for the confirm step', async () => {
  // A busy session is not a failure the user should just be toasted about —
  // the UI needs `code` to know to offer "reload anyway", and `reason` to say
  // which of the two refusals it was.
  nextResponse = {
    status: 409,
    body: {
      applied: false,
      reason: 'session is mid-turn',
      code: 'SESSION_BUSY',
      error: 'This session is mid-turn.',
    },
  };
  const err = await reloadProjectSessionConfig('P1', 'S1').then(
    () => null,
    (e: unknown) => e as { code?: string; data?: { reason?: string } },
  );
  expect(err?.code).toBe('SESSION_BUSY');
  expect(err?.data?.reason).toBe('session is mid-turn');
});

function reloadStreamResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  );
}

test('reloadProjectSessionConfigStream requests SSE and reports each server phase', async () => {
  const events: unknown[] = [];
  const fetchStub = mock(
    async (_url: unknown, opts: { body?: string; headers?: HeadersInit } = {}) => {
      expect(JSON.parse(opts.body ?? '{}')).toEqual({ refresh_repo: false });
      expect(new Headers(opts.headers).get('accept')).toBe('text/event-stream');
      return reloadStreamResponse([
        ': heartbeat\n',
        'data: {"type":"phase","phase":"checking-session"}\n\n',
        'data: {"type":"phase","phase":"compiling-config"}\n\n',
        'data: {"type":"phase","phase":"applying-config"}\n\n',
        'data: {"type":"phase","phase":"confirming-config"}\n\n',
        'data: {"type":"done","result":{"applied":true,"previous_etag":"a","etag":"b","repo_refreshed":false,"commit_sha":null,"agent_files":"not-requested","detail":"Reloaded"}}\n\n',
      ]);
    },
  );

  const result = await reloadProjectSessionConfigStream(
    'P1',
    'S1',
    { refresh_repo: false },
    (event) => events.push(event),
    { fetch: fetchStub as unknown as typeof fetch },
  );

  expect(events).toEqual([
    { type: 'phase', phase: 'checking-session' },
    { type: 'phase', phase: 'compiling-config' },
    { type: 'phase', phase: 'applying-config' },
    { type: 'phase', phase: 'confirming-config' },
    {
      type: 'done',
      result: {
        applied: true,
        previous_etag: 'a',
        etag: 'b',
        repo_refreshed: false,
        commit_sha: null,
        agent_files: 'not-requested',
        detail: 'Reloaded',
      },
    },
  ]);
  expect(result.applied).toBe(true);
  expect(String(fetchStub.mock.calls[0]?.[0])).toContain('/projects/P1/sessions/S1/reload-stream');
});

test('reloadProjectSessionConfigStream preserves busy status, code, and reason', async () => {
  const fetchStub = mock(async () =>
    reloadStreamResponse([
      'data: {"type":"error","error":"This session is mid-turn.","code":"SESSION_BUSY","status":409,"reason":"session is mid-turn"}\n\n',
    ]),
  );

  const error = await reloadProjectSessionConfigStream('P1', 'S1', {}, () => {}, {
    fetch: fetchStub as unknown as typeof fetch,
  }).then(
    () => null,
    (value: unknown) => value as { status?: number; code?: string; data?: { reason?: string } },
  );

  expect(error?.status).toBe(409);
  expect(error?.code).toBe('SESSION_BUSY');
  expect(error?.data?.reason).toBe('session is mid-turn');
});

test('reloadProjectSessionConfigStream rejects a bare close instead of claiming success', async () => {
  const fetchStub = mock(async () =>
    reloadStreamResponse(['data: {"type":"phase","phase":"checking-session"}\n\n']),
  );

  await expect(
    reloadProjectSessionConfigStream('P1', 'S1', {}, () => {}, {
      fetch: fetchStub as unknown as typeof fetch,
    }),
  ).rejects.toThrow('Reload stream ended without a result');
});

test('stopProjectSession POSTs to /stop', async () => {
  nextResponse = { status: 200, body: { ok: true, session_id: 'S1', status: 'stopped' } };
  const result = await stopProjectSession('P1', 'S1');
  expect(last().url).toContain('/projects/P1/sessions/S1/stop');
  expect(last().method).toBe('POST');
  expect(result.status).toBe('stopped');
});

test('getProjectSessionScope reads canonical session scope', async () => {
  const scope = {
    secrets_allowlist: ['GMAIL_TOKEN'],
    required_connectors: null,
    connector_bindings: { gmail: { connection_id: 'AUTH-1' } },
    dropped_secrets: [],
    added_secrets: [],
    dropped_bindings: [],
    retroactive: true,
    connector_bindings_configured: false,
    connector_bindings_inherit_unbound: true,
    detail: 'Current session scope.',
  };
  nextResponse = { status: 200, body: scope };
  const result = await getProjectSessionScope('P1', 'S1');
  expect(last().url).toBe('http://test.local/projects/P1/sessions/S1/scope');
  expect(last().method).toBe('GET');
  expect(result.connector_bindings.gmail).toEqual({ connection_id: 'AUTH-1' });
  // `connector_bindings` is the RESOLVED map, identical for an inherited and an
  // overridden session. This flag is the only thing that separates them, so a
  // client can stop calling an inherited default "nothing selected".
  expect(result.connector_bindings_configured).toBe(false);
  expect(result.connector_bindings_inherit_unbound).toBe(true);
});

test('setProjectSessionScope clears a connector override with null', async () => {
  nextResponse = {
    status: 200,
    body: {
      secrets_allowlist: null,
      required_connectors: null,
      connector_bindings: { gmail: { connection_id: 'AUTH-DEFAULT' } },
      dropped_secrets: [],
      added_secrets: [],
      dropped_bindings: [],
      retroactive: true,
      connector_bindings_configured: false,
      connector_bindings_inherit_unbound: false,
      detail: 'Connector access is back to the project defaults.',
    },
  };
  const result = await setProjectSessionScope('P1', 'S1', { connector_bindings: null });
  expect(last().method).toBe('PUT');
  // `null` is the REVERT verb. `{}` is its opposite — an explicit "no
  // connectors at all" — so the two must reach the wire unchanged.
  expect(last().body).toEqual({ connector_bindings: null });
  expect(result.connector_bindings_configured).toBe(false);
});

test('setProjectSessionScope replaces connections with canonical input', async () => {
  nextResponse = {
    status: 200,
    body: {
      secrets_allowlist: [],
      connector_bindings: { gmail: { connection_id: 'AUTH-2' } },
      dropped_secrets: [],
      added_secrets: [],
      dropped_bindings: [],
      retroactive: true,
      detail: 'Applies from the next prompt.',
    },
  };
  const result = await setProjectSessionScope('P1', 'S1', {
    secrets: [],
    connector_bindings: { gmail: { connection_id: 'AUTH-2' } },
  });
  expect(last().url).toBe('http://test.local/projects/P1/sessions/S1/scope');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({
    secrets: [],
    connector_bindings: { gmail: { connection_id: 'AUTH-2' } },
  });
  expect(result.connector_bindings).toEqual({
    gmail: { connection_id: 'AUTH-2' },
  });
});

test('session contracts omit usage attribution keys', () => {
  type ListOptions = NonNullable<Parameters<typeof listProjectSessions>[1]>;
  const createInput: IsNever<SessionAttributionKey<CreateProjectSessionInput>> = true;
  const response: IsNever<SessionAttributionKey<ProjectSession>> = true;
  const listOptions: IsNever<SessionAttributionKey<ListOptions>> = true;

  expect([createInput, response, listOptions]).toEqual([true, true, true]);
});

// ── The prompt inbox ────────────────────────────────────────────────────────
//
// A prompt is durable from the instant the composer accepts it. Before this the
// queue lived in the browser's localStorage, so a closed tab, a second device
// or a crash lost it silently. These four readers are the whole client surface.

test('createSessionPrompt POSTs the submission name, the wire id, the parts and the picks', async () => {
  nextResponse = {
    status: 202,
    body: { prompt_id: 'cmd-1', state: 'queued', message_id: 'msg_a', deduped: false },
  };
  const result = await createSessionPrompt('P1', 'S1', {
    clientMessageId: 'q_1',
    messageId: 'msg_a',
    parts: [{ type: 'text', text: 'say hi' }],
    overrides: { agent: 'build', model: { providerID: 'p', modelID: 'm' } },
  });
  expect(last().url).toBe('http://test.local/projects/P1/sessions/S1/prompts');
  expect(last().method).toBe('POST');
  // snake_case on the wire, like every other payload on this surface.
  expect(last().body).toEqual({
    client_message_id: 'q_1',
    message_id: 'msg_a',
    parts: [{ type: 'text', text: 'say hi' }],
    overrides: { agent: 'build', model: { providerID: 'p', modelID: 'm' } },
  });
  expect(result).toEqual({
    prompt_id: 'cmd-1',
    state: 'queued',
    message_id: 'msg_a',
    deduped: false,
  });
});

test('createSessionPrompt asks for a server re-mint only when the caller says its id is stale', async () => {
  // A caller that minted its id somewhere the live transcript was unreadable
  // (the one-time localStorage migration) says so, and the server re-mints
  // against the live root before delivering. Absent by default: an ordinary
  // send mints against a transcript it can see, and re-minting it would be a
  // sandbox read on the delivery path of every message.
  nextResponse = {
    status: 202,
    body: { prompt_id: 'cmd-1', state: 'queued', message_id: 'msg_a', deduped: false },
  };
  await createSessionPrompt('P1', 'S1', {
    clientMessageId: 'q_1',
    messageId: 'msg_a',
    parts: [{ type: 'text', text: 'say hi' }],
    remintOnDelivery: true,
  });
  expect(last().body).toEqual({
    client_message_id: 'q_1',
    message_id: 'msg_a',
    parts: [{ type: 'text', text: 'say hi' }],
    remint_on_delivery: true,
  });

  await createSessionPrompt('P1', 'S1', {
    clientMessageId: 'q_2',
    messageId: 'msg_b',
    parts: [{ type: 'text', text: 'say hi' }],
  });
  expect(last().body).toEqual({
    client_message_id: 'q_2',
    message_id: 'msg_b',
    parts: [{ type: 'text', text: 'say hi' }],
  });
});

test('createSessionPrompt reports a dedupe rather than hiding it', async () => {
  // Same `clientMessageId` = the SAME durable row, enforced by a unique index.
  // The caller needs to know it re-named an existing prompt instead of adding
  // a second one.
  nextResponse = {
    status: 200,
    body: { prompt_id: 'cmd-1', state: 'delivering', message_id: 'msg_a', deduped: true },
  };
  const result = await createSessionPrompt('P1', 'S1', {
    clientMessageId: 'q_1',
    messageId: 'msg_a',
    parts: [{ type: 'text', text: 'say hi' }],
  });
  expect(result.deduped).toBe(true);
  expect(last().body).toEqual({
    client_message_id: 'q_1',
    message_id: 'msg_a',
    parts: [{ type: 'text', text: 'say hi' }],
  });
});

test('listSessionPrompts hits GET .../prompts and hands the rows through verbatim', async () => {
  const prompt: SessionPrompt = {
    prompt_id: 'cmd-1',
    client_message_id: 'q_1',
    message_id: 'msg_a',
    state: 'waiting',
    reason: 'turn_active',
    text: 'say hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-08-18T00:00:00.000Z',
    available_at: '2026-08-18T00:00:02.000Z',
  };
  nextResponse = { status: 200, body: { prompts: [prompt] } };
  const result = await listSessionPrompts('P1', 'S1');
  expect(last().url).toBe('http://test.local/projects/P1/sessions/S1/prompts');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ prompts: [prompt] });
});

test('deleteSessionPrompt DELETEs one prompt and returns what it removed', async () => {
  // The removal is offered with an Undo, and the row is hard-deleted, so this
  // response is the only place the full body still exists. Restoring from the
  // list view instead drops attachments and overrides and truncates the text.
  const removed: RemovedSessionPrompt = {
    prompt_id: 'cmd-1',
    client_message_id: 'q_1',
    message_id: 'msg_a',
    parts: [
      { type: 'text', text: 'say hi' },
      { type: 'file', mime: 'image/png', url: 'https://files.test/a.png' },
    ],
    overrides: { model: { providerID: 'anthropic', modelID: 'claude-x' } },
  };
  nextResponse = { status: 200, body: { removed } };
  expect(await deleteSessionPrompt('P1', 'S1', 'cmd-1')).toEqual(removed);
  expect(last().url).toBe('http://test.local/projects/P1/sessions/S1/prompts/cmd-1');
  expect(last().method).toBe('DELETE');
});

test('retrySessionPrompt POSTs .../retry and returns the requeued row', async () => {
  nextResponse = {
    status: 200,
    body: {
      prompt_id: 'cmd-1',
      client_message_id: 'q_1',
      message_id: 'msg_a',
      state: 'queued',
      reason: null,
      text: 'say hi',
      attempts: 0,
      last_error: null,
      created_at: '2026-08-18T00:00:00.000Z',
      available_at: '2026-08-18T00:00:00.000Z',
    },
  };
  const result = await retrySessionPrompt('P1', 'S1', 'cmd-1');
  expect(last().url).toBe('http://test.local/projects/P1/sessions/S1/prompts/cmd-1/retry');
  expect(last().method).toBe('POST');
  // The wire id is UNCHANGED by a retry: the proxy's delivery claim is keyed on
  // it, so a retry of a delivery that actually landed is still absorbed.
  expect(result.message_id).toBe('msg_a');
  expect(result.state).toBe('queued');
});

test('holdSessionPrompts POSTs .../prompts/hold with the flag and returns the queue', async () => {
  // Stop has to reach the QUEUE, and the queue is on the server now: pausing a
  // browser-local drain leaves the admission gate free to deliver the very
  // message the user pressed Stop to get ahead of.
  nextResponse = { status: 200, body: { prompts: [] } };
  const result = await holdSessionPrompts('P1', 'S1', true);
  expect(last().url).toBe('http://test.local/projects/P1/sessions/S1/prompts/hold');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ held: true });
  expect(result).toEqual({ prompts: [] });
});

test('a prompt call throws on a non-2xx instead of returning a half-answer', async () => {
  nextResponse = { status: 402, body: { error: 'out of credits' } };
  await expect(
    createSessionPrompt('P1', 'S1', {
      clientMessageId: 'q_1',
      messageId: 'msg_a',
      parts: [{ type: 'text', text: 'hi' }],
    }),
  ).rejects.toBeTruthy();
});

// ── The session-open bundle ─────────────────────────────────────────────────
// ONE round trip for what a session view needs to paint and arm. The client
// function is deliberately thin: every leg is the SAME shape its own endpoint
// returns, so a caller can hand a leg straight to the consumer that already
// reads that endpoint.

test('getSessionOpenBundle hits GET /projects/:id/sessions/:sid/open-bundle', async () => {
  nextResponse = { status: 200, body: { observed_at: 'now' } };
  const bundle = await getSessionOpenBundle('P1', 'S1');
  expect(last().url).toContain('/projects/P1/sessions/S1/open-bundle');
  expect(last().method).toBe('GET');
  expect(bundle.observed_at).toBe('now');
});

test('getSessionOpenBundle asks for the transcript window it was given', async () => {
  nextResponse = { status: 200, body: { observed_at: 'now' } };
  await getSessionOpenBundle('P1', 'S1', { transcript: 0 });
  // `transcript=0` is the POINTER-only read a client with a warm store wants.
  // Omitting the parameter would silently ask for 40 messages it already has.
  expect(last().url).toContain('open-bundle?transcript=0');
});

test('getSessionOpenBundle throws when the response is unsuccessful', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(getSessionOpenBundle('P1', 'S1')).rejects.toBeTruthy();
});
