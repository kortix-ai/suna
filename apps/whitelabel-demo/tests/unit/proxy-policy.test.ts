import { describe, expect, test } from 'bun:test';
import { SESSION_CREATE, SESSION_ONE, blockedReason, localAnswer } from '../../src/server/proxy-policy';

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
    ['GET', `${P}/connections`],
    ['GET', `${P}/secrets`],
    ['GET', `${P}/files`],
    ['GET', `${P}/files/content`],
    ['GET', `${P}/files/search`],
    ['GET', `${P}/files/history`],
    ['GET', `${P}/branches`],
    ['GET', `${P}/commits`],
    ['GET', `${P}/version-diff`],
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

  test('every other path is left to blockedReason', () => {
    expect(localAnswer('GET', 'accounts/tokens', none, null, member)).toBeNull();
    expect(localAnswer('POST', 'accounts/me', none, null, member)).toBeNull();
    expect(localAnswer('GET', `${S}/prompts`, none, null, member)).toBeNull();
  });
});
