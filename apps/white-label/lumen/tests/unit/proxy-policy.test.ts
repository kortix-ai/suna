import { describe, expect, test } from 'bun:test';
import {
  SESSION_CREATE,
  SESSION_ONE,
  blockedReason,
  forwardedHeaders,
  localAnswer,
  memberSessionCreateBody,
  redactError,
  redactIdentity,
  redactsIdentity,
} from '../../src/server/proxy-policy';

const P = 'projects/0b8c9d3e-1111-4222-8333-944455556666';
const S = `${P}/sessions/7a1b2c3d-1111-4222-8333-944455556666`;
const member = { userId: 'lumen_user_1' };

describe('proxy policy: what a member token may do', () => {
  const RT = 'p/sbx_1/8000';
  // Every request the customer journey made through the proxy (sign up,
  // workspace per template, thread, streamed prompt, question, stop, edit and
  // rewind, attachment, @-mention, Files, Changes, Preview, Scope, rename,
  // restart, delete, reload mid-stream). Ids are synthetic.
  const OBSERVED: ReadonlyArray<readonly [string, string]> = [
    ['GET', P],
    ['GET', `${P}/detail`],
    ['GET', `${P}/change-requests`],
    ['GET', `${P}/model-picker`],
    ['GET', `${P}/model-defaults`],
    ['GET', `${P}/connections`],
    ['GET', `${P}/secrets`],
    ['POST', `${P}/sessions`],
    ['POST', `${P}/attachments`],
    ['POST', `${P}/attachments/9c0d1e2f-1111-4222-8333-944455556666/complete`],
    ['GET', S],
    ['PATCH', S],
    ['DELETE', S],
    ['GET', `${S}/events`],
    ['GET', `${S}/snapshot`],
    ['GET', `${S}/transcript`],
    ['GET', `${S}/turn`],
    ['GET', `${S}/prompts`],
    ['GET', `${S}/message-authors`],
    ['GET', `${S}/model-usage`],
    ['GET', `${S}/scope`],
    ['GET', `${S}/previews`],
    ['POST', `${S}/start`],
    ['POST', `${S}/restart`],
    ['POST', `${S}/prompts`],
    ['POST', `${S}/prompts/hold`],
    ['PATCH', `${S}/prompts/pr_1`],
    ['DELETE', `${S}/prompts/pr_1`],
    ['GET', 'p/config'],
    ['GET', `${RT}/kortix/health`],
    ['GET', `${RT}/session`],
    ['GET', `${RT}/session/status`],
    ['GET', `${RT}/session/ses_1`],
    ['GET', `${RT}/session/ses_1/message`],
    ['GET', `${RT}/session/ses_1/todo`],
    ['GET', `${RT}/permission`],
    ['GET', `${RT}/question`],
    ['GET', `${RT}/provider`],
    ['GET', `${RT}/command`],
    ['GET', `${RT}/path`],
    ['GET', `${RT}/project/current`],
    ['GET', `${RT}/lsp/diagnostics`],
    ['GET', `${RT}/file`],
    ['GET', `${RT}/find/file`],
    ['POST', `${RT}/session/ses_1/abort`],
    ['POST', `${RT}/session/ses_1/revert`],
    ['POST', `${RT}/question/que_1/reply`],
    ['POST', `${RT}/permission/per_1/reply`],
  ];

  test.each(OBSERVED)('%s %s passes', (method, path) => {
    expect(blockedReason(method, path)).toBeNull();
  });

  // Routes the UI never called. Operator surfaces, and broad rules that used to let them through.
  const REFUSED: ReadonlyArray<readonly [string, string]> = [
    ['GET', `${S}/drive-sync/d1/files`],
    ['GET', `${S}/drive-sync/d1/files/content`],
    ['GET', `${S}/drives`],
    ['GET', `${S}/audit`],
    ['GET', `${S}/log`],
    ['GET', `${S}/log/entries`],
    ['GET', `${S}/config`],
    ['GET', `${S}/participants`],
    ['GET', `${S}/reminders`],
    ['GET', `${S}/public-shares`],
    ['GET', `${S}/connect-requests`],
    ['GET', `${S}/provider-secret-pools`],
    ['GET', `${P}/sessions`],
    ['GET', `${P}/agents`],
    ['GET', `${P}/files/archive`],
    // The repository spans every matter (each session's branch is named after its session id).
    ['GET', `${P}/files`],
    ['GET', `${P}/files/content`],
    ['GET', `${P}/files/search`],
    ['GET', `${P}/files/history`],
    ['GET', `${P}/branches`],
    ['GET', `${P}/commits`],
    ['GET', `${P}/commits/81af8705bc8e64adaeda3717cc9f081dcca520f9`],
    ['GET', `${P}/version-diff`],
    ['GET', `${P}/files/raw`],
    ['POST', `${RT}/kortix/runtime/sessions/ses_1/prompt`],
    ['POST', `${RT}/kortix/runtime/anything`],
    ['POST', `${RT}/kortix/abort`],
    ['POST', `${RT}/session/ses_1/prompt_async`],
    ['POST', `${RT}/session/ses_1/message`],
    ['GET', `${RT}/global/event`],
    ['GET', `${RT}/find/symbol`],
    ['GET', `${RT}/file/content`],
    ['POST', `${P}/turn-permission`],
    // Encoded `..` and a double slash, as the policy would see them if one reached it.
    ['GET', `${P}/%2e%2e/secrets`],
    ['GET', `projects/%2e%2e/accounts`],
    ['GET', `${P}//secrets`],
    ['GET', `${S}//prompts`],
    ['GET', `${S}/`],
  ];

  test.each(REFUSED)('%s %s is refused', (method, path) => {
    expect(blockedReason(method, path)).not.toBeNull();
  });

  test("credentials, the operator's identity and other surfaces are refused on read", () => {
    for (const path of [
      `${P}/cli-token`,
      `${P}/git-token`,
      `${P}/git-credential`,
      `${P}/access`,
      `${P}/members`,
      `${P}/triggers`,
      'accounts',
      'accounts/me',
      'accounts/tokens',
      'accounts/88ff5524-1111-4222-8333-944455556666/iam/members',
      'billing/account-state',
      'user/me',
      'projects',
    ]) {
      expect([path, blockedReason('GET', path)]).not.toEqual([path, null]);
    }
  });

  test('a new session is allowed (the route tags it and records the thread)', () => {
    expect(blockedReason('POST', `${P}/sessions`)).toBeNull();
    expect(SESSION_CREATE.test(`${P}/sessions`)).toBe(true);
    expect(SESSION_CREATE.test(`${S}/start`)).toBe(false);
  });

  test('a session update is routed through the tag filter (patchSession)', () => {
    expect(SESSION_ONE.test(S)).toBe(true);
    expect(SESSION_ONE.test(`${S}/start`)).toBe(false);
  });

  test('warm sessions are refused: they skip the Lumen tags and are shared by every member', () => {
    expect(blockedReason('POST', `${P}/sessions/warm`)).not.toBeNull();
    expect(blockedReason('POST', `${P}/sessions/warm/claim`)).not.toBeNull();
    expect(blockedReason('GET', `${P}/sessions/warm`)).not.toBeNull();
  });

  test('session runtime: process, terminal, git, environment and file writes are refused', () => {
    const RT = 'p/sbx_1/8000';
    for (const [method, path] of [
      ['POST', `${RT}/session/ses_1/shell`],
      ['POST', `${RT}/session/ses_1/command`],
      ['POST', `${RT}/session/ses_1/init`],
      ['POST', `${RT}/pty`],
      ['GET', `${RT}/pty/pty_1/connect`],
      ['POST', `${RT}/kortix/pty`],
      ['POST', `${RT}/kortix/env-rpc`],
      ['GET', `${RT}/kortix/env`],
      ['POST', `${RT}/kortix/git/commit`],
      ['POST', `${RT}/kortix/tools/run`],
      ['POST', `${RT}/kortix/drive-sync/push`],
      ['POST', `${RT}/kortix/refresh`],
      ['POST', `${RT}/file/upload`],
      ['DELETE', `${RT}/file`],
      ['GET', `${RT}/global/config`],
      ['PATCH', `${RT}/global/config`],
      ['PUT', `${RT}/auth/openai`],
      ['POST', `${RT}/mcp`],
      ['GET', 'p/sbx_1/5173/'],
      ['POST', 'p/share'],
      ['GET', 'p/share'],
      ['POST', 'p/auth'],
    ]) {
      expect([method, path, blockedReason(method, path)]).not.toEqual([method, path, null]);
    }
  });

  test('runtime file reads stay inside the workspace', () => {
    const q = (path: string) => new URLSearchParams({ path });
    const RT = 'p/sbx_1/8000';
    expect(blockedReason('GET', `${RT}/file`, q('src/app.ts'))).toBeNull();
    expect(blockedReason('GET', `${RT}/file`, q('/workspace/src/app.ts'))).toBeNull();
    for (const path of ['/tmp/.t', '/home/kortix/.bashrc', '/dev/shm/kortix/agent-env.sh', '../etc/passwd', '/workspace/../tmp/x', '~/.ssh/id']) {
      expect([path, blockedReason('GET', `${RT}/file`, q(path))]).not.toEqual([path, null]);
    }
  });

  test('public links, visibility, reminders and credential pools are refused', () => {
    for (const [method, path] of [
      ['POST', `${S}/public-shares`],
      ['GET', `${S}/public-shares`],
      ['DELETE', `${S}/public-shares/kps_1`],
      ['PUT', `${S}/sharing`],
      ['POST', `${S}/reminders`],
      ['PATCH', `${S}/reminders/rem_1`],
      ['PUT', `${S}/scope`],
      ['PUT', `${S}/archive`],
      ['POST', `${S}/prompts/pr_1/retry`],
      ['GET', `${S}/provider-secret-pools`],
      ['PUT', `${S}/provider-secret-pools/openai`],
      ['POST', `${S}/commit-push`],
      ['POST', `${S}/config-release`],
      ['POST', `${S}/log/restore`],
      ['PUT', `${S}/drive-sync/d1/files/content`],
    ]) {
      expect([method, path, blockedReason(method, path)]).not.toEqual([method, path, null]);
    }
  });

  test('a session delete is routed through the thread check (SESSION_ONE)', () => {
    expect(blockedReason('DELETE', S)).toBeNull();
    expect(SESSION_ONE.test(S)).toBe(true);
  });

  test('project configuration and deletion are refused', () => {
    for (const [method, path] of [
      ['DELETE', P],
      ['POST', `${P}/cli-token`],
      ['PUT', `${P}/agents/finance-analyst/config`],
      ['PUT', `${P}/default-agent`],
      ['POST', `${P}/secrets`],
      ['POST', `${P}/access`],
      ['POST', `${P}/triggers`],
      ['POST', 'accounts/tokens'],
      ['POST', 'projects/provision'],
    ]) {
      expect(blockedReason(method, path)).not.toBeNull();
    }
  });
});

describe('proxy policy: account reads Lumen answers itself', () => {
  const none = new URLSearchParams();

  test('accounts/me is the Lumen member, not the operator', async () => {
    const res = localAnswer('GET', 'accounts/me', none, null, member);
    expect(await res?.json()).toEqual({ user_id: 'lumen_user_1', email: '', accounts: [] });
  });

  test('permission probes deny every configuration action without calling Kortix', async () => {
    const one = localAnswer(
      'GET',
      'accounts/a/iam/members/u/effective',
      new URLSearchParams({ action: 'project.secret.read', resourceType: 'project', resourceId: 'p1' }),
      null,
      member,
    );
    expect(await one?.json()).toEqual({
      action: 'project.secret.read',
      resource_type: 'project',
      resource_id: 'p1',
      allowed: false,
      reason: 'Managed by the Lumen operator',
    });

    const batch = localAnswer(
      'POST',
      'accounts/a/iam/members/u/effective:batch',
      none,
      { probes: [{ action: 'project.write', resourceType: 'project', resourceId: 'p1' }, { action: 'member.read' }] },
      member,
    );
    const body = (await batch?.json()) as { results: Array<{ action: string; allowed: boolean }> };
    expect(body.results.map((r) => [r.action, r.allowed])).toEqual([
      ['project.write', false],
      ['member.read', false],
    ]);
  });

  test("a session's audit log and participants are empty, without calling Kortix", async () => {
    const audit = localAnswer('GET', `${S}/audit`, none, null, member);
    expect(await audit?.json()).toEqual({
      session_id: '7a1b2c3d-1111-4222-8333-944455556666',
      audit_access: false,
      count: 0,
      events: [],
      next_cursor: null,
      actions: [],
    });
    const people = localAnswer('GET', `${S}/participants`, none, null, member);
    expect(await people?.json()).toEqual({ participants: [], total: 0, multi_user: false });
    expect(localAnswer('POST', `${S}/audit`, none, null, member)).toBeNull();
  });

  test("a session's mounted folders are empty: the firm Drive spans every matter", async () => {
    const drives = localAnswer('GET', `${S}/drives`, none, null, member);
    expect(await drives?.json()).toEqual({ drives: [], personal: false, skipped: [], skippedMessage: null });
  });

  test('every other path is left to blockedReason', () => {
    expect(localAnswer('GET', 'accounts/tokens', none, null, member)).toBeNull();
    expect(localAnswer('POST', 'accounts/me', none, null, member)).toBeNull();
    expect(localAnswer('GET', `${S}/prompts`, none, null, member)).toBeNull();
  });
});

describe('proxy request headers: only what Kortix needs leaves Lumen', () => {
  test('the SDK and browser headers a session route reads pass; cookies, identity and client hints do not', () => {
    const out = forwardedHeaders(
      new Headers({
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'last-event-id': '42',
        'if-none-match': 'W/"1"',
        'x-kortix-client-version': '1.2.3',
        cookie: 'better-auth.session_token=secret',
        authorization: 'Bearer matter.abc',
        'user-agent': 'Mozilla/5.0',
        referer: 'http://localhost:3020/app/matters/1',
        origin: 'http://localhost:3020',
        'accept-language': 'en-GB',
        'sec-ch-ua': '"Chromium"',
        'x-forwarded-for': '203.0.113.7',
        'x-kortix-impersonate': 'user_2',
      }),
    );
    expect([...out.entries()].sort()).toEqual([
      ['accept', 'text/event-stream'],
      ['content-type', 'application/json'],
      ['if-none-match', 'W/"1"'],
      ['last-event-id', '42'],
      ['x-kortix-client-version', '1.2.3'],
    ]);
  });
});

describe("proxy responses: the operator's Kortix identity never reaches a member", () => {
  const OPERATOR = 'operator@example.test';
  const session = {
    session_id: 's1',
    name: 'Q3',
    owner_email: OPERATOR,
    owner_name: 'Operator',
    owner_avatar_url: 'https://example.test/a.png',
    initiator: { type: 'member', id: 'u_op', label: OPERATOR },
  };

  test('the session record (create, read, rename) and the snapshot lose owner name, email, avatar and initiator label', () => {
    for (const path of [`${P}/sessions`, S]) {
      expect(redactsIdentity(path)).toBe(true);
      const out = redactIdentity(path, session);
      expect(JSON.stringify(out)).not.toContain(OPERATOR);
      expect(out).toMatchObject({ session_id: 's1', name: 'Q3', owner_name: null, initiator: { type: 'member', id: 'u_op', label: null } });
    }
    const snap = redactIdentity(`${S}/snapshot`, { observed_at: 't', session });
    expect(JSON.stringify(snap)).not.toContain(OPERATOR);
    expect(snap).toMatchObject({ observed_at: 't', session: { session_id: 's1', owner_email: null } });
  });

  test('message authors and stops drop member entries; agent-session authors stay', () => {
    const member = { kind: 'member', user_id: 'u_op', name: OPERATOR, email: OPERATOR };
    const agent = { kind: 'session', session_id: 's2', name: 'Research', agent: 'research' };
    const out = redactIdentity(`${S}/message-authors`, {
      authors: { m1: member, m2: agent },
      initial_author: member,
      stops: { m1: member },
    });
    expect(out).toEqual({ authors: { m2: agent }, initial_author: null, stops: {} });
  });

  test("records drop the operator's Kortix user and account ids and the managed repository", () => {
    const ids = { account_id: 'acc_op', created_by: 'u_op', owner_id: 'u_op' };
    const session = { session_id: 's1', ...ids, owner_email: OPERATOR, opencode_model: 'kortix/x' };
    const cases: Array<[string, unknown]> = [
      [P, { project_id: 'p1', name: 'Firm', ...ids, repo_url: 'https://github.com/managed-x/p1', manifest_path: 'kortix.yaml', description: 'A Kortix project.' }],
      [`${P}/detail`, { manifest_raw: 'kortix_version: 2', experimental_features: [{ key: 'genui', enabled: true, description: 'KORTIX_GENUI=1 in kortixd' }] }],
      [S, session],
      [`${P}/sessions`, [session]],
      [`${S}/snapshot`, { ...ids, session }],
      [`${P}/change-requests`, { change_requests: [{ id: 'cr1', ...ids, title: 'x' }] }],
    ];
    for (const [path, body] of cases) {
      expect(redactsIdentity(path)).toBe(true);
      const out = JSON.stringify(redactIdentity(path, body));
      expect(out).not.toMatch(/acc_op|u_op|managed-x|manifest_path|Kortix project|kortix_version|KORTIX_GENUI/);
    }
  });

  test('an upstream error body names no platform and carries no check diagnostics', () => {
    const out = redactError({
      error: 'Project-scoped token cannot access a different project [check=token-project-scope:cross-project principal=project-scoped-pat project=p path=/v1/projects/p]',
      account_id: 'acc_op',
      detail: 'kortix gateway refused',
    });
    expect(out).toEqual({ error: 'Project-scoped token cannot access a different project', detail: 'Lumen gateway refused' });
  });

  test("a failed turn's error copy names Lumen, not Kortix", () => {
    const error = { name: 'RuntimeTurnFailed', message: 'The sandbox reported that this turn failed, but the error did not reach Kortix.' };
    const path = `${S}/turn`;
    expect(redactsIdentity(path)).toBe(true);
    const out = redactIdentity(path, { turns: [], last_ended: { end_reason: 'failed', error }, recent_failures: [{ error }], can_stop: true });
    expect(JSON.stringify(out)).not.toContain('Kortix');
    expect(out).toMatchObject({
      last_ended: { end_reason: 'failed', error: { name: 'RuntimeTurnFailed', message: 'The sandbox reported that this turn failed, but the error did not reach Lumen.' } },
      can_stop: true,
    });
    const snap = redactIdentity(`${S}/snapshot`, { session: { session_id: 's1' }, turn: { last_ended: { error } } });
    expect(JSON.stringify(snap)).not.toContain('Kortix');
  });

  test("the slash-command list leaves out the platform's own commands", () => {
    const path = 'p/sbx_1/8000/command';
    expect(redactsIdentity(path)).toBe(true);
    const out = redactIdentity(path, [
      { name: 'review', description: 'Review changes', source: 'command' },
      { name: 'kortix-cli', description: 'Drive the platform', source: 'skill' },
      { name: 'customize-opencode', description: 'Tune the harness', source: 'skill' },
      { name: 'pdf', description: 'Read PDFs. Uses the Kortix file tools.', source: 'skill' },
      { name: 'xlsx', description: 'Spreadsheets', source: 'skill', template: 'Use the Kortix sandbox to open the file.' },
    ]);
    expect((out as { name: string }[]).map((c) => c.name)).toEqual(['review', 'xlsx']);
    expect((out as { template?: string }[])[1].template).toBe('Use the Lumen sandbox to open the file.');
  });

  test('the open-session snapshot filters its command list the same way', () => {
    const snap = redactIdentity(`${S}/snapshot`, {
      session: { session_id: 's1' },
      runtime: { state: { agents: { value: [{ name: 'general', description: 'Generic Kortix worker' }] }, commands: { value: [
        { name: 'kortix-cli', description: 'Drive Kortix itself', source: 'skill' },
        { name: 'pdf', description: 'PDFs', source: 'skill', template: 'Kortix tools' },
      ] } } },
    }) as { runtime: { state: { commands: { value: unknown[] } } } };
    expect(snap.runtime.state.commands.value).toEqual([{ name: 'pdf', description: 'PDFs', source: 'skill', template: 'Lumen tools' }]);
    expect(JSON.stringify(snap)).not.toContain('Kortix');
  });

  test('the project record and its detail name Lumen, not the platform', () => {
    for (const path of [P, `${P}/detail`]) {
      expect(redactsIdentity(path)).toBe(true);
      const out = redactIdentity(path, {
        project_id: 'p1',
        manifest: { project: { description: 'A Kortix project.' } },
        features: [{ key: 'llm_gateway', description: 'Route through the managed Kortix LLM gateway', enabled: true }],
      });
      expect(JSON.stringify(out)).not.toContain('Kortix');
      expect(out).toMatchObject({ project_id: 'p1', features: [{ key: 'llm_gateway', enabled: true }] });
    }
    expect(redactsIdentity(`${P}/files`)).toBe(false);
  });

  test('other routes pass through unchanged', () => {
    expect(redactsIdentity(`${S}/events`)).toBe(false);
    expect(redactsIdentity(`${S}/prompts`)).toBe(false);
    const body = { owner_email: OPERATOR };
    expect(redactIdentity(`${S}/prompts`, body)).toBe(body);
  });
});

describe('proxy policy: a member session create carries only member keys', () => {
  test('fork_from_session_id and operator keys are dropped; name, labels, metadata, agent and prompt stay', () => {
    const body = memberSessionCreateBody({
      name: 'x', labels: ['a'], metadata: { k: 1 }, agent_name: 'lumen-counsel', initial_prompt: 'hi',
      fork_from_session_id: '22222222-1111-4222-8333-944455556666', connector_bindings: { gmail: {} },
      session_id: 's', sandbox_slug: 'b', model: 'm', provider_secret_pools: {},
    });
    expect(body).toEqual({ name: 'x', labels: ['a'], metadata: { k: 1 }, agent_name: 'lumen-counsel', initial_prompt: 'hi' });
  });
});
