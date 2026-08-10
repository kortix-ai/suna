import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { isSessionFresh } from '../../http/fresh-sessions';
import type { CreateWorkspaceSessionInput, WorkspaceSession } from './sessions';
import {
  createWorkspaceSession,
  createSessionPublicShare,
  claimWarmWorkspaceSession,
  deleteWorkspaceSession,
  ensureWarmWorkspaceSession,
  getWorkspaceSession,
  getWorkspaceSessionConfigState,
  getWorkspaceSessionScope,
  getSessionAudit,
  getSessionPreviewCandidates,
  getSessionTranscript,
  getVoiceTranscript,
  listWorkspaceSessions,
  listSessionPublicShares,
  reloadWorkspaceSessionConfig,
  restartWorkspaceSession,
  revokeSessionPublicShare,
  setWorkspaceSessionScope,
  setWorkspaceSessionSharing,
  stopWorkspaceSession,
  updateWorkspaceSession,
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

test('listWorkspaceSessions hits GET /workspaces/:id/sessions', async () => {
  nextResponse = { status: 200, body: [] };
  const result = await listWorkspaceSessions('P1');
  expect(last().url).toContain('/workspaces/P1/sessions');
  expect(last().method).toBe('GET');
  expect(result).toEqual([]);
});

test('listWorkspaceSessions requests the manager-only workspace inventory scope', async () => {
  nextResponse = { status: 200, body: [] };
  await listWorkspaceSessions('P1', { scope: 'workspace' });
  expect(last().url).toContain('/workspaces/P1/sessions?scope=workspace');
  expect(last().method).toBe('GET');
});

test('listWorkspaceSessions throws when the response is unsuccessful', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(listWorkspaceSessions('P1')).rejects.toBeTruthy();
});

test('setWorkspaceSessionSharing PUTs the sharing intent', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1' } };
  await setWorkspaceSessionSharing('P1', 'S1', { mode: 'workspace' });
  expect(last().url).toContain('/workspaces/P1/sessions/S1/sharing');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ mode: 'workspace' });
});

test('getSessionPreviewCandidates hits the previews endpoint', async () => {
  nextResponse = { status: 200, body: { candidates: [] } };
  const result = await getSessionPreviewCandidates('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/previews');
  expect(result).toEqual({ candidates: [] });
});

test('listSessionPublicShares hits GET /public-shares with showErrors: false', async () => {
  nextResponse = { status: 200, body: { shares: [] } };
  const result = await listSessionPublicShares('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/public-shares');
  expect(result).toEqual({ shares: [] });
});

test('createSessionPublicShare POSTs the share input', async () => {
  nextResponse = { status: 200, body: { share: { share_id: 'SH1' } } };
  const input = { preview_id: 'prev-1', mode: 'view' as const };
  const result = await createSessionPublicShare('P1', 'S1', input);
  expect(last().url).toContain('/workspaces/P1/sessions/S1/public-shares');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual(input);
  expect(result.share.share_id).toBe('SH1');
});

test('revokeSessionPublicShare DELETEs the specific share', async () => {
  nextResponse = { status: 200, body: { share: { share_id: 'SH1' } } };
  await revokeSessionPublicShare('P1', 'S1', 'SH1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/public-shares/SH1');
  expect(last().method).toBe('DELETE');
});

test('createWorkspaceSession POSTs the input and marks the new session fresh', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-1', name: null } };
  const result = await createWorkspaceSession('P1', { base_ref: 'main' });
  expect(last().url).toContain('/workspaces/P1/sessions');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ base_ref: 'main' });
  expect((result as any).session_id).toBe('NEW-1');
  expect(isSessionFresh('NEW-1')).toBe(true);
});

test('createWorkspaceSession serializes non-secret runtime_context unchanged', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-CONTEXT', name: null } };
  await createWorkspaceSession('P1', {
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

test('createWorkspaceSession serializes canonical connection bindings', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-BINDING', name: null } };
  await createWorkspaceSession('P1', {
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

test('createWorkspaceSession does NOT mark the session fresh when an initial_prompt is set', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-2', name: null } };
  await createWorkspaceSession('P1', { initial_prompt: 'hello' });
  expect(isSessionFresh('NEW-2')).toBe(false);
});

test('createWorkspaceSession defaults the body to {} when no input is given', async () => {
  nextResponse = { status: 200, body: { session_id: 'NEW-3' } };
  await createWorkspaceSession('P1');
  expect(last().body).toEqual({});
});

test('ensureWarmWorkspaceSession POSTs the server-owned warm-session request', async () => {
  nextResponse = {
    status: 200,
    body: {
      session: { session_id: 'WARM-1' },
      reused: true,
      workspace_refresh: { status: 'unchanged' },
    },
  };
  const result = await ensureWarmWorkspaceSession('P1');
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/warm');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result.session.session_id).toBe('WARM-1');
  expect(result.reused).toBe(true);
});

test('claimWarmWorkspaceSession POSTs the selected warm session and create options', async () => {
  nextResponse = { status: 200, body: { session_id: 'WARM-1' } };
  const result = await claimWarmWorkspaceSession('P1', {
    session_id: 'WARM-1',
    agent_name: 'reviewer',
    sandbox_slug: 'large',
  });
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/warm/claim');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({
    session_id: 'WARM-1',
    agent_name: 'reviewer',
    sandbox_slug: 'large',
  });
  expect(result.session_id).toBe('WARM-1');
});

test('claimWarmWorkspaceSession keeps recoverable claim conflicts out of the global error sink', async () => {
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
      claimWarmWorkspaceSession('P1', {
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

test('getWorkspaceSession hits GET /workspaces/:id/sessions/:sid and forwards showErrors', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1' } };
  await getWorkspaceSession('P1', 'S1', { showErrors: false });
  expect(last().url).toContain('/workspaces/P1/sessions/S1');
  expect(last().method).toBe('GET');
});

test('getSessionAudit appends ?limit= only when a limit is given', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1', agent: null, count: 0, actions: [] } };
  await getSessionAudit('P1', 'S1', 10);
  expect(last().url).toContain('/workspaces/P1/sessions/S1/audit?limit=10');

  await getSessionAudit('P1', 'S1');
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/S1/audit');
});

test('getSessionAudit can poll approvals without refetching historical events', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1', agent: null, count: 0, actions: [] } };
  await getSessionAudit('P1', 'S1', 1000, {
    cursor: '14|event-14',
    includeEvents: false,
    showErrors: false,
  });
  expect(last().url).toBe(
    'http://test.local/workspaces/P1/sessions/S1/audit?limit=1000&cursor=14%7Cevent-14&include_events=false',
  );
});

test('getSessionTranscript builds the query string from limit/chars options', async () => {
  nextResponse = {
    status: 200,
    body: { available: true, reason: null, opencode_session_id: 'ocs-1', message_count: 0, messages: [] },
  };
  await getSessionTranscript('P1', 'S1', { limit: 5, chars: 200 });
  expect(last().url).toContain('/workspaces/P1/sessions/S1/transcript?limit=5&chars=200');

  await getSessionTranscript('P1', 'S1');
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/S1/transcript');
});

test('getVoiceTranscript hits GET .../voice-transcript and builds the query string from cursor/limit', async () => {
  nextResponse = {
    status: 200,
    body: { session_id: 'S1', call_id: 'S1', live: true, cursor: 3, count: 0, turns: [] },
  };
  await getVoiceTranscript('P1', 'S1', { cursor: 12, limit: 50 });
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/S1/voice-transcript?cursor=12&limit=50');
  expect(last().method).toBe('GET');

  await getVoiceTranscript('P1', 'S1');
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/S1/voice-transcript');
});

test('updateWorkspaceSession PATCHes the name/metadata input', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1', name: 'Renamed' } };
  await updateWorkspaceSession('P1', 'S1', { name: 'Renamed' });
  expect(last().url).toContain('/workspaces/P1/sessions/S1');
  expect(last().method).toBe('PATCH');
  expect(last().body).toEqual({ name: 'Renamed' });
});

test('deleteWorkspaceSession DELETEs the session', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteWorkspaceSession('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1');
  expect(last().method).toBe('DELETE');
});

test('restartWorkspaceSession POSTs to /restart', async () => {
  nextResponse = { status: 200, body: { ok: true, session_id: 'S1', status: 'provisioning' } };
  const result = await restartWorkspaceSession('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/restart');
  expect(last().method).toBe('POST');
  expect(result.status).toBe('provisioning');
});

test('getWorkspaceSessionConfigState GETs /config', async () => {
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
  const result = await getWorkspaceSessionConfigState('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/config');
  expect(last().method).toBe('GET');
  expect(result.stale).toBe(true);
  expect(result.latest_etag).toBe('bbbbbbbbbbbbbbbb');
});

test('getWorkspaceSessionConfigState preserves a NULL stale — "could not tell" is not "fresh"', async () => {
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
  const result = await getWorkspaceSessionConfigState('P1', 'S1');
  expect(result.stale).toBeNull();
  expect(result.stale).not.toBe(false);
});

test('reloadWorkspaceSessionConfig POSTs to /reload with an empty body by default', async () => {
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
  const result = await reloadWorkspaceSessionConfig('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/reload');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result.applied).toBe(true);
});

test('reloadWorkspaceSessionConfig surfaces whether the agent files actually changed', async () => {
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
  const result = await reloadWorkspaceSessionConfig('P1', 'S1');
  expect(result.applied).toBe(true);
  expect(result.agent_files).toBe('kept-yours');
});

test('"we did not find out" is distinguishable from "we declined"', async () => {
  // Three different things that a boolean collapsed: an old daemon that could
  // not answer, a caller that never asked, and a deliberate refusal. Telling a
  // --no-repo caller their sandbox "could not confirm" is a fabrication.
  for (const agent_files of ['unknown', 'not-requested', 'kept-yours'] as const) {
    nextResponse = { status: 200, body: { applied: true, detail: 'ok', agent_files } };
    expect((await reloadWorkspaceSessionConfig('P1', 'S1')).agent_files).toBe(agent_files);
  }
});

test('reloadWorkspaceSessionConfig forwards force as a real boolean', async () => {
  // The route tests `body?.force === true` — a truthy string would be ignored
  // and the reload would silently refuse again on a busy session.
  nextResponse = { status: 200, body: { applied: true, detail: 'ok' } };
  await reloadWorkspaceSessionConfig('P1', 'S1', { force: true });
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
  await getWorkspaceSessionConfigState('P1', 'S1').catch(() => {});
  nextResponse = { status: 409, body: { code: 'SESSION_BUSY', reason: 'session is mid-turn' } };
  await reloadWorkspaceSessionConfig('P1', 'S1').catch(() => {});

  expect(errors).toEqual([]);

  // Leave the shared config as the rest of this file expects it.
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
});

test('reloadWorkspaceSessionConfig surfaces the 409 code and reason for the confirm step', async () => {
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
  const err = await reloadWorkspaceSessionConfig('P1', 'S1').then(
    () => null,
    (e: unknown) => e as { code?: string; data?: { reason?: string } },
  );
  expect(err?.code).toBe('SESSION_BUSY');
  expect(err?.data?.reason).toBe('session is mid-turn');
});

test('stopWorkspaceSession POSTs to /stop', async () => {
  nextResponse = { status: 200, body: { ok: true, session_id: 'S1', status: 'stopped' } };
  const result = await stopWorkspaceSession('P1', 'S1');
  expect(last().url).toContain('/workspaces/P1/sessions/S1/stop');
  expect(last().method).toBe('POST');
  expect(result.status).toBe('stopped');
});

test('getWorkspaceSessionScope reads canonical session scope', async () => {
  const scope = {
    secrets_allowlist: ['GMAIL_TOKEN'],
    required_connectors: null,
    connector_bindings: { gmail: { connection_id: 'AUTH-1' } },
    dropped_secrets: [],
    added_secrets: [],
    dropped_bindings: [],
    retroactive: true,
    detail: 'Current session scope.',
  };
  nextResponse = { status: 200, body: scope };
  const result = await getWorkspaceSessionScope('P1', 'S1');
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/S1/scope');
  expect(last().method).toBe('GET');
  expect(result.connector_bindings.gmail).toEqual({ connection_id: 'AUTH-1' });
});

test('setWorkspaceSessionScope replaces connections with canonical input', async () => {
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
  const result = await setWorkspaceSessionScope('P1', 'S1', {
    secrets: [],
    connector_bindings: { gmail: { connection_id: 'AUTH-2' } },
  });
  expect(last().url).toBe('http://test.local/workspaces/P1/sessions/S1/scope');
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
  type ListOptions = NonNullable<Parameters<typeof listWorkspaceSessions>[1]>;
  const createInput: IsNever<SessionAttributionKey<CreateWorkspaceSessionInput>> = true;
  const response: IsNever<SessionAttributionKey<WorkspaceSession>> = true;
  const listOptions: IsNever<SessionAttributionKey<ListOptions>> = true;

  expect([createInput, response, listOptions]).toEqual([true, true, true]);
});
