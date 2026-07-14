import { test, expect, beforeEach, mock } from 'bun:test';
import { createKortix, SessionNotReadyError } from './kortix';
import { isConfigured } from '../http/config';
import { listFiles as globalListFiles } from '../files/client';
import { ApiError } from '../http/api/errors';

// Capture every outbound request the facade makes.
let calls: { url: string; method: string; body?: unknown }[] = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: unknown } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body,
    });
    return new Response(JSON.stringify({ ok: true, secrets: [], candidates: [], sessions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('createKortix wires the platform seam', () => {
  expect(isConfigured()).toBe(true);
});

test('facade exposes the core namespaces', () => {
  expect(typeof kortix.projects.list).toBe('function');
  expect(typeof kortix.accounts.list).toBe('function');
  expect(typeof kortix.project).toBe('function');
  expect(typeof kortix.session).toBe('function');
});

test('project(id) handle binds the id and hits the right endpoint', async () => {
  await kortix.project('PID123').secrets.list();
  expect(last().url).toContain('/projects/PID123/secrets');
  expect(last().method).toBe('GET');
});

test('session(projectId, sessionId) binds both ids', async () => {
  await kortix.session('PID123', 'SID456').previews();
  expect(last().url).toContain('/projects/PID123/sessions/SID456/previews');
});

test('project(id).session(sid) is the same session handle', async () => {
  await kortix.project('PA').session('SB').get();
  expect(last().url).toContain('/projects/PA/sessions/SB');
});

test('top-level projects.list hits /projects', async () => {
  await kortix.projects.list();
  expect(last().url).toContain('/projects');
});

test('session(...).audit hits the audit endpoint with the given limit', async () => {
  await kortix.session('PID123', 'SID456').audit(10);
  expect(last().url).toContain('/projects/PID123/sessions/SID456/audit?limit=10');
});

test('project(id).access.invite forwards a time-bound expiry to the backend', async () => {
  const expiry = '2027-01-01T00:00:00.000Z';
  await kortix.project('PID123').access.invite('teammate@essentia.com', 'member', expiry);
  expect(last().url).toContain('/projects/PID123/access/invite');
  expect(last().method).toBe('POST');
  expect(last().body).toMatchObject({
    email: 'teammate@essentia.com',
    role: 'member',
    expires_at: expiry,
  });
});

test('project(id).access.invite omits expires_at for a permanent grant', async () => {
  await kortix.project('PID123').access.invite('teammate@essentia.com', 'member');
  expect(last().body).not.toHaveProperty('expires_at');
});

test('project(id).access.invite sends expires_at:null to clear a bound', async () => {
  await kortix.project('PID123').access.invite('teammate@essentia.com', 'member', null);
  expect(last().body).toMatchObject({ expires_at: null });
});

// ── review / approvals / gateway / channels / apps / model-defaults / sandbox
// / github / transcribe / sandbox-shares — the facade groups wired to close
// the projects-client coverage gap (~85/187 wired before) ───────────────────

test('project(id).review hits the review-items endpoints', async () => {
  await kortix.project('PID123').review.list({ segment: 'needs_you' });
  expect(last().url).toContain('/projects/PID123/review/items?segment=needs_you');

  await kortix.project('PID123').review.get('RI1');
  expect(last().url).toContain('/projects/PID123/review/items/RI1');

  await kortix.project('PID123').review.act('RI1', { verdict: 'approve' });
  expect(last().url).toContain('/projects/PID123/review/items/RI1/act');
  expect(last().method).toBe('POST');

  await kortix.project('PID123').review.bulkAct({ ids: ['RI1', 'RI2'], verdict: 'reject' });
  expect(last().url).toContain('/projects/PID123/review/bulk');

  await kortix.project('PID123').review.submit({ kind: 'output', title: 'Result' });
  expect(last().url).toContain('/projects/PID123/review/items');
  expect(last().method).toBe('POST');
});

test('project(id).approvals hits the approvals inbox endpoints', async () => {
  await kortix.project('PID123').approvals.list();
  expect(last().url).toContain('/projects/PID123/approvals');

  await kortix.project('PID123').approvals.sessionsNeedingInput();
  expect(last().url).toContain('/projects/PID123/approvals/needs-input');

  await kortix.project('PID123').approvals.resolve('EXEC1', 'approve');
  expect(last().url).toContain('/projects/PID123/approvals/EXEC1');
  expect(last().method).toBe('POST');
});

test('project(id).gateway hits the gateway observability + budget + key endpoints', async () => {
  await kortix.project('PID123').gateway.logs({ limit: 10 });
  expect(last().url).toContain('/projects/PID123/gateway/logs?limit=10');

  await kortix.project('PID123').gateway.overview(7);
  expect(last().url).toContain('/projects/PID123/gateway/overview?days=7');

  await kortix.project('PID123').gateway.budgets();
  expect(last().url).toContain('/projects/PID123/gateway/budgets');

  await kortix.project('PID123').gateway.setBudget({ scope: 'project', limit_usd: 50 });
  expect(last().url).toContain('/projects/PID123/gateway/budgets');
  expect(last().method).toBe('PUT');

  await kortix.project('PID123').gateway.createKey('ci-key');
  expect(last().url).toContain('/projects/PID123/gateway/keys');
  expect(last().method).toBe('POST');

  await kortix.project('PID123').gateway.revokeKey('KEY1');
  expect(last().url).toContain('/projects/PID123/gateway/keys/KEY1');
  expect(last().method).toBe('DELETE');
});

test('project(id).gateway.routing binds policy CRUD and preview to the project', async () => {
  await kortix.project('PID123').gateway.routing.get();
  expect(last().url).toContain('/projects/PID123/gateway/routing-policy');
  expect(last().method).toBe('GET');

  await kortix.project('PID123').gateway.routing.set({
    defaultModel: 'codex/gpt-5.6-sol',
    visionModel: null,
    defaultFallback: { models: ['glm-5.2'], fallbackOn: 'any-error' },
    rules: [],
  });
  expect(last().method).toBe('PUT');

  await kortix.project('PID123').gateway.routing.preview({
    requestedModel: 'auto',
    imageInput: false,
  });
  expect(last().url).toContain('/projects/PID123/gateway/routing-policy/preview');
  expect(last().method).toBe('POST');

  await kortix.project('PID123').gateway.routing.reset();
  expect(last().method).toBe('DELETE');
});

test('project(id).channels covers slack, email and meet', async () => {
  await kortix.project('PID123').channels.slack.installation();
  expect(last().url).toContain('/projects/PID123/channels/slack/installation');

  await kortix.project('PID123').channels.email.mode();
  expect(last().url).toContain('/projects/PID123/channels/email/mode');

  await kortix.project('PID123').channels.meet.voices();
  expect(last().url).toContain('/projects/PID123/channels/meet/voices');

  await kortix.project('PID123').channels.meet.setVoice('voice-1');
  expect(last().url).toContain('/projects/PID123/channels/meet/voice');
  expect(last().method).toBe('PUT');
});

test('project(id) omits the retired hosted-app surface', () => {
  expect('apps' in (kortix.project('PID123') as object)).toBe(false);
});

test('project(id).modelDefaults gets/sets/clears the default model', async () => {
  await kortix.project('PID123').modelDefaults.get();
  expect(last().url).toContain('/projects/PID123/model-defaults');

  await kortix.project('PID123').modelDefaults.set({ scope: 'project', model: 'anthropic/claude' });
  expect(last().method).toBe('PUT');

  await kortix.project('PID123').modelDefaults.clear({ scope: 'project' });
  expect(last().method).toBe('DELETE');
});

test('project(id).modelPicker loads the compact selector catalog', async () => {
  await kortix.project('PID123').modelPicker();
  expect(last().url).toContain('/projects/PID123/model-picker');
  expect(last().method).toBe('GET');
});

test('project(id).sandbox hits the sandbox/snapshot/template admin endpoints', async () => {
  await kortix.project('PID123').sandbox.list();
  expect(last().url).toContain('/projects/PID123/sandboxes');

  await kortix.project('PID123').sandbox.snapshots();
  expect(last().url).toContain('/projects/PID123/snapshots');

  await kortix.project('PID123').sandbox.rebuildSnapshot();
  expect(last().url).toContain('/projects/PID123/snapshots/rebuild');
  expect(last().method).toBe('POST');
});

test('project(id).setAgentScope binds the project id + agent name', async () => {
  await kortix.project('PID123').setAgentScope('researcher', { env: 'all' });
  expect(last().url).toContain('/projects/PID123/agents/researcher/scope');
  expect(last().method).toBe('PUT');
});

test('kortix.github covers install/list/link/repo endpoints (account-scoped, not project-scoped)', async () => {
  await kortix.github.getInstallation('ACC1');
  expect(last().url).toContain('/projects/github/installation?account_id=ACC1');

  await kortix.github.listRepositories('ACC1');
  expect(last().url).toContain('/projects/github/repositories?account_id=ACC1');
});

test('kortix.sandboxShares hits /p/share (sandbox-scoped, not project-scoped)', async () => {
  await kortix.sandboxShares.list('SB1');
  expect(last().url).toContain('/p/share?sandbox_id=SB1');

  await kortix.sandboxShares.create({ sandboxId: 'SB1', port: 8000 });
  expect(last().url).toContain('/p/share');
  expect(last().method).toBe('POST');

  await kortix.sandboxShares.revoke('SB1', 'TOK1');
  expect(last().url).toContain('/p/share/TOK1?sandbox_id=SB1');
  expect(last().method).toBe('DELETE');
});

// ── wave 4: account-invite lifecycle, resource-grants CRUD, group-grant
// attach/detach, connector extras (pipedream/policies/oauth), and the
// remaining project-level admin toggles ────────────────────────────────────

test('kortix.accounts covers cancel/resend invite (account-scoped)', async () => {
  await kortix.accounts.cancelInvite('ACC1', 'INV1');
  expect(last().url).toContain('/accounts/ACC1/invites/INV1');
  expect(last().method).toBe('DELETE');

  await kortix.accounts.resendInvite('ACC1', 'INV1');
  expect(last().url).toContain('/accounts/ACC1/invites/INV1/resend');
  expect(last().method).toBe('POST');
});

test('kortix.accountInvites covers describe/accept/decline (invite-token scoped, no account id)', async () => {
  await kortix.accountInvites.describe('INV1');
  expect(last().url).toContain('/account-invites/INV1');
  expect(last().method).toBe('GET');

  await kortix.accountInvites.accept('INV1');
  expect(last().url).toContain('/account-invites/INV1/accept');
  expect(last().method).toBe('POST');

  await kortix.accountInvites.decline('INV1');
  expect(last().url).toContain('/account-invites/INV1/decline');
  expect(last().method).toBe('POST');
});

test('project(id).access covers group-grant attach/update/detach', async () => {
  await kortix.project('PID123').access.attachGroupGrant('GRP1', 'member');
  expect(last().url).toContain('/projects/PID123/group-grants');
  expect(last().method).toBe('POST');

  await kortix.project('PID123').access.updateGroupGrant('GRP1', 'editor');
  expect(last().url).toContain('/projects/PID123/group-grants/GRP1');
  expect(last().method).toBe('PATCH');

  await kortix.project('PID123').access.detachGroupGrant('GRP1');
  expect(last().url).toContain('/projects/PID123/group-grants/GRP1');
  expect(last().method).toBe('DELETE');
});

test('project(id).access.resourceGrants covers list/create/remove', async () => {
  await kortix.project('PID123').access.resourceGrants.list();
  expect(last().url).toContain('/projects/PID123/resource-grants');
  expect(last().method).toBe('GET');

  await kortix.project('PID123').access.resourceGrants.create({
    resourceType: 'secret',
    resourceId: 'MY_SECRET',
    principalType: 'member',
    principalId: 'user-1',
  });
  expect(last().url).toContain('/projects/PID123/resource-grants');
  expect(last().method).toBe('POST');

  await kortix.project('PID123').access.resourceGrants.remove('G9');
  expect(last().url).toContain('/projects/PID123/resource-grants/G9');
  expect(last().method).toBe('DELETE');
});

test('project(id).secrets covers provider OAuth start/poll', async () => {
  await kortix.project('PID123').secrets.startProviderOAuth('chatgpt');
  expect(last().url).toContain('/projects/PID123/oauth/chatgpt/start');
  expect(last().method).toBe('POST');

  await kortix.project('PID123').secrets.pollProviderOAuth('chatgpt', 'FLOW1');
  expect(last().url).toContain('/projects/PID123/oauth/chatgpt/poll');
  expect(last().method).toBe('POST');
});

test('project(id).connectors covers credential-mode/sensitive/policies/pipedream', async () => {
  await kortix.project('PID123').connectors.setName('slack-1', 'My Slack');
  expect(last().url).toContain('/executor/projects/PID123/connectors/slack-1/name');

  await kortix.project('PID123').connectors.setCredential('slack-1', 'secret-value');
  expect(last().url).toContain('/executor/projects/PID123/connectors/slack-1/credential');

  await kortix.project('PID123').connectors.setCredentialMode('slack-1', 'shared');
  expect(last().url).toContain('/executor/projects/PID123/connectors/slack-1/credential-mode');

  await kortix.project('PID123').connectors.setSensitive('slack-1', true);
  expect(last().url).toContain('/executor/projects/PID123/connectors/slack-1/sensitive');

  await kortix.project('PID123').connectors.policies.get('slack-1');
  expect(last().url).toContain('/executor/projects/PID123/connectors/slack-1/policies');
  expect(last().method).toBe('GET');

  await kortix.project('PID123').connectors.policies.set('slack-1', [{ match: '*', action: 'block' }]);
  expect(last().url).toContain('/executor/projects/PID123/connectors/slack-1/policies');
  expect(last().method).toBe('PUT');

  await kortix.project('PID123').connectors.pipedream.listApps('gmail');
  expect(last().url).toContain('/executor/projects/PID123/pipedream/apps?q=gmail');

  await kortix.project('PID123').connectors.pipedream.connect('gmail-1');
  expect(last().url).toContain('/executor/projects/PID123/connectors/gmail-1/connect');
  expect(last().method).toBe('POST');

  await kortix.project('PID123').connectors.pipedream.finalize('gmail-1');
  expect(last().url).toContain('/executor/projects/PID123/connectors/gmail-1/connect/finalize');
  expect(last().method).toBe('POST');
});

test('kortix.connectStatus hits the top-level connect-status endpoint (not project-scoped)', async () => {
  await kortix.connectStatus();
  expect(last().url).toContain('/executor/connect-status');
});

test('project(id) covers experimental-feature toggle, sandbox provider pin, and repo-collaborator invite', async () => {
  await kortix.project('PID123').updateExperimentalFeature('marketplace', true);
  expect(last().url).toContain('/projects/PID123/experimental');
  expect(last().method).toBe('PATCH');

  await kortix.project('PID123').setDefaultAgent('kortix');
  expect(last().url).toContain('/projects/PID123/default-agent');
  expect(last().method).toBe('PUT');

  await kortix.project('PID123').sandbox.setProvider('daytona');
  expect(last().url).toContain('/projects/PID123/sandbox-provider');
  expect(last().method).toBe('PATCH');

  await kortix.project('PID123').git.inviteCollaborator('octocat');
  expect(last().url).toContain('/projects/PID123/git/collaborators');
  expect(last().method).toBe('POST');
});

test('kortix.projects.createRepo hits the create-repo endpoint (not bound to an existing project id)', async () => {
  await kortix.projects.createRepo({ name: 'new-repo' });
  expect(last().url).toContain('/projects/create-repo');
  expect(last().method).toBe('POST');
});

test('kortix.transcribe hits the top-level /transcription endpoint (not project-scoped)', async () => {
  const file = new File(['audio'], 'clip.webm', { type: 'audio/webm' });
  await kortix.transcribe(file);
  expect(last().url).toContain('/transcription');
  expect(last().method).toBe('POST');
});

// ── wave 5: token minting, billing read surface, marketplace/registry
// install, session transcript, CR request-changes, account audit — closing
// the gaps a coverage audit found against the ~499 API routes ──────────────

test('kortix.accounts.tokens covers list/create/revoke (account-scoped CLI PATs)', async () => {
  await kortix.accounts.tokens.list('ACC1');
  expect(last().url).toContain('/accounts/tokens?account_id=ACC1');
  expect(last().method).toBe('GET');

  await kortix.accounts.tokens.create({ name: 'ci-key', accountId: 'ACC1', projectId: 'PID1' });
  expect(last().url).toContain('/accounts/tokens');
  expect(last().method).toBe('POST');

  await kortix.accounts.tokens.revoke('TOK1', 'ACC1');
  expect(last().url).toContain('/accounts/tokens/TOK1?account_id=ACC1');
  expect(last().method).toBe('DELETE');
});

test('project(id).tokens covers list/create/revoke (project-scoped CLI PATs)', async () => {
  await kortix.project('PID123').tokens.list();
  expect(last().url).toContain('/projects/PID123/cli-token');
  expect(last().method).toBe('GET');

  await kortix.project('PID123').tokens.create({ name: 'agent-token' });
  expect(last().url).toContain('/projects/PID123/cli-token');
  expect(last().method).toBe('POST');

  await kortix.project('PID123').tokens.revoke('TOK1');
  expect(last().url).toContain('/projects/PID123/cli-token/TOK1');
  expect(last().method).toBe('DELETE');
});

test('kortix.billing covers the read surface (account-state, transactions, credits, tiers)', async () => {
  await kortix.billing.accountState();
  expect(last().url).toContain('/billing/account-state');

  await kortix.billing.accountStateMinimal();
  expect(last().url).toContain('/billing/account-state/minimal');

  await kortix.billing.transactions({ accountId: 'ACC1', limit: 10 });
  expect(last().url).toContain('/billing/transactions?account_id=ACC1&limit=10');

  await kortix.billing.transactionsSummary({ days: 7 });
  expect(last().url).toContain('/billing/transactions/summary?days=7');

  await kortix.billing.creditBreakdown();
  expect(last().url).toContain('/billing/credit-breakdown');

  await kortix.billing.usageHistory(14);
  expect(last().url).toContain('/billing/usage-history?days=14');

  await kortix.billing.tierConfigurations();
  expect(last().url).toContain('/billing/tier-configurations');
});

test('session(...).transcript hits the compact transcript endpoint with limit/chars', async () => {
  await kortix.session('PID123', 'SID456').transcript({ limit: 10, chars: 200 });
  expect(last().url).toContain('/projects/PID123/sessions/SID456/transcript?limit=10&chars=200');
  expect(last().method).toBe('GET');
});

test('project(id).changeRequests.requestChanges hits the request-changes endpoint', async () => {
  await kortix.project('PID123').changeRequests.requestChanges('CR1', 'please fix the tests');
  expect(last().url).toContain('/projects/PID123/change-requests/CR1/request-changes');
  expect(last().method).toBe('POST');
});

test('kortix.accounts.audit covers log/export/webhooks CRUD', async () => {
  await kortix.accounts.audit.log('ACC1', { action: 'iam.', limit: 20 });
  expect(last().url).toContain('/accounts/ACC1/audit?action=iam.&limit=20');
  expect(last().method).toBe('GET');

  await kortix.accounts.audit.export('ACC1', { format: 'csv' });
  expect(last().url).toContain('/accounts/ACC1/audit/export?format=csv');

  await kortix.accounts.audit.webhooks.list('ACC1');
  expect(last().url).toContain('/accounts/ACC1/audit/webhooks');
  expect(last().method).toBe('GET');

  await kortix.accounts.audit.webhooks.create('ACC1', { name: 'siem', url: 'https://siem.example.com/hook' });
  expect(last().url).toContain('/accounts/ACC1/audit/webhooks');
  expect(last().method).toBe('POST');

  await kortix.accounts.audit.webhooks.update('ACC1', 'WH1', { enabled: false });
  expect(last().url).toContain('/accounts/ACC1/audit/webhooks/WH1');
  expect(last().method).toBe('PATCH');

  await kortix.accounts.audit.webhooks.remove('ACC1', 'WH1');
  expect(last().url).toContain('/accounts/ACC1/audit/webhooks/WH1');
  expect(last().method).toBe('DELETE');
});

// ── setup links / manifest validate / git token / slack files / meet speak /
// gateway playground / billing mutations / public marketplace / validateToken
// — closing the LAST projects-client coverage gaps ─────────────────────────

test('project(id).setupLinks mints secret-entry and connect-request links', async () => {
  await kortix.project('PID123').setupLinks.requestSecret({ names: ['STRIPE_KEY'] });
  expect(last().url).toContain('/projects/PID123/secret-requests');
  expect(last().method).toBe('POST');

  await kortix.project('PID123').setupLinks.requestConnector({ slug: 'github' });
  expect(last().url).toContain('/projects/PID123/connect-requests');
  expect(last().method).toBe('POST');
});

test('project(id).validateManifest posts the raw TOML text', async () => {
  await kortix.project('PID123').validateManifest('[project]\nname = "x"');
  expect(last().url).toContain('/projects/PID123/manifest/validate');
  expect(last().method).toBe('POST');
});

test('project(id).gitToken mints a scoped push token', async () => {
  await kortix.project('PID123').gitToken();
  expect(last().url).toContain('/projects/PID123/git-token');
  expect(last().method).toBe('POST');
});

test('project(id).channels.slack covers file download + upload proxies', async () => {
  await kortix.project('PID123').channels.slack.getFile('https://files.slack.com/x');
  expect(last().url).toContain('/projects/PID123/channels/slack/file?url=');
  expect(last().method).toBe('GET');

  await kortix.project('PID123').channels.slack.uploadFile({
    channel: 'C1',
    filename: 'report.pdf',
    contentBase64: 'YWJj',
  });
  expect(last().url).toContain('/projects/PID123/channels/slack/file/upload');
  expect(last().method).toBe('POST');
});

test('project(id).channels.meet.speak posts bot id + text', async () => {
  await kortix.project('PID123').channels.meet.speak('bot-1', 'hello there');
  expect(last().url).toContain('/projects/PID123/channels/meet/speak');
  expect(last().method).toBe('POST');
});

test('project(id).gateway.playground posts prompt + models', async () => {
  await kortix.project('PID123').gateway.playground('Say hi', ['gpt-4o', 'claude-3']);
  expect(last().url).toContain('/projects/PID123/gateway/playground');
  expect(last().method).toBe('POST');
});

test('kortix.billing.checkout covers create + confirm session', async () => {
  await kortix.billing.checkout.createSession({
    tierKey: 'pro',
    successUrl: 'https://app.example.com/success',
    cancelUrl: 'https://app.example.com/cancel',
  });
  expect(last().url).toContain('/billing/create-checkout-session');
  expect(last().method).toBe('POST');

  await kortix.billing.checkout.confirmSession('cs_123');
  expect(last().url).toContain('/billing/confirm-checkout-session');
  expect(last().method).toBe('POST');
});

test('kortix.billing.subscription covers portal/cancel/reactivate/downgrade/proration', async () => {
  await kortix.billing.subscription.createPortalSession('https://app.example.com/billing');
  expect(last().url).toContain('/billing/create-portal-session');
  expect(last().method).toBe('POST');

  await kortix.billing.subscription.cancel('too expensive');
  expect(last().url).toContain('/billing/cancel-subscription');

  await kortix.billing.subscription.reactivate();
  expect(last().url).toContain('/billing/reactivate-subscription');

  await kortix.billing.subscription.scheduleDowngrade('starter');
  expect(last().url).toContain('/billing/schedule-downgrade');

  await kortix.billing.subscription.cancelScheduledChange();
  expect(last().url).toContain('/billing/cancel-scheduled-change');

  await kortix.billing.subscription.prorationPreview('price_123');
  expect(last().url).toContain('/billing/proration-preview?new_price_id=price_123');
  expect(last().method).toBe('GET');
});

test('kortix.billing.credits covers purchase + auto-topup get/configure', async () => {
  await kortix.billing.credits.purchase({ amount: 20 });
  expect(last().url).toContain('/billing/purchase-credits');
  expect(last().method).toBe('POST');

  await kortix.billing.credits.autoTopupSettings();
  expect(last().url).toContain('/billing/auto-topup/settings');
  expect(last().method).toBe('GET');

  await kortix.billing.credits.configureAutoTopup({ enabled: true, threshold: 5, amount: 20 });
  expect(last().url).toContain('/billing/auto-topup/configure');
  expect(last().method).toBe('POST');
});

test('kortix.marketplace covers public catalog browse + authed sources CRUD (top-level, not project-scoped)', async () => {
  await kortix.marketplace.items({ query: 'slack' });
  expect(last().url).toContain('/marketplace/items?query=slack');
  expect(last().method).toBe('GET');

  await kortix.marketplace.item('kortix:researcher');
  expect(last().url).toContain('/marketplace/items/kortix%3Aresearcher');

  await kortix.marketplace.itemFile('kortix:researcher', 'agent.md');
  expect(last().url).toContain('/marketplace/items/kortix%3Aresearcher/file?path=agent.md');

  await kortix.marketplace.marketplaces();
  expect(last().url).toContain('/marketplace/marketplaces');

  await kortix.marketplace.featured();
  expect(last().url).toContain('/marketplace/marketplaces/featured');

  await kortix.marketplace.sources.list();
  expect(last().url).toContain('/marketplace/sources');
  expect(last().method).toBe('GET');

  await kortix.marketplace.sources.add({ address: 'https://github.com/acme/registry' });
  expect(last().url).toContain('/marketplace/sources');
  expect(last().method).toBe('POST');

  await kortix.marketplace.sources.remove('SRC1');
  expect(last().url).toContain('/marketplace/sources/SRC1');
  expect(last().method).toBe('DELETE');
});

test('kortix.validateToken hits /accounts/me and never throws', async () => {
  const result = await kortix.validateToken();
  expect(last().url).toContain('/accounts/me');
  expect(result.valid).toBe(true);
});

// ── per-handle runtime isolation (regression: two session handles used to
// share the module-global "active runtime", so the second handle's
// ensureReady() silently redirected the first handle's send/health/preview
// calls to the wrong sandbox) ──────────────────────────────────────────────

function sessionStartPayload(externalId: string, acpSessionId: string) {
  return {
    stage: 'ready',
    agent_name: 'agent',
    retriable: false,
    sandbox: { external_id: externalId },
    runtime_protocol: 'acp',
    runtime_id: externalId,
    runtime_session_id: acpSessionId,
  };
}

function requestUrl(input: unknown): string {
  return input instanceof Request ? input.url : String(input);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockTwoSessionRuntimes() {
  return mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'POST' });
    if (url.includes('/sessions/SESS-A/start')) {
      return jsonResponse(sessionStartPayload('sb-A', 'ocs-A'));
    }
    if (url.includes('/sessions/SESS-B/start')) {
      return jsonResponse(sessionStartPayload('sb-B', 'ocs-B'));
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
}

test('two session handles resolve independent ACP runtimes without crossing preview state', async () => {
  globalThis.fetch = mockTwoSessionRuntimes();
  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

  const a = k.session('PROJ', 'SESS-A');
  const b = k.session('PROJ', 'SESS-B');

  await a.ensureReady();
  await b.ensureReady(); // resolves AFTER a — used to clobber the shared global runtime

  expect(a.previewUrl(3000)).toContain('/p/sb-A/3000/');
  expect(b.previewUrl(3000)).toContain('/p/sb-B/3000/');
});

test('previewUrl uses the handle\'s own sandbox id, not whichever session resolved last', async () => {
  globalThis.fetch = mockTwoSessionRuntimes();
  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

  const a = k.session('PROJ', 'SESS-A');
  const b = k.session('PROJ', 'SESS-B');

  await a.ensureReady();
  await b.ensureReady();

  expect(a.previewUrl(3000, '/docs')).toBe('http://test.local/p/sb-A/3000/docs');
  expect(b.previewUrl(3000, '/docs')).toBe('http://test.local/p/sb-B/3000/docs');
});

test('previewUrl()/proxyUrl() throw SessionNotReadyError before ensureReady()', () => {
  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const s = k.session('PROJ', 'SESS-NEW');

  expect(() => s.previewUrl(3000)).toThrow(SessionNotReadyError);
  expect(() => s.proxyUrl('http://localhost:3000')).toThrow(SessionNotReadyError);
});

// health() is a liveness POLL, not an action gated on the runtime being up —
// pollers (e.g. a header dot ticking every 15s on a fresh inline
// `kortix.session(...)` handle, see apps/whitelabel-demo/session-header.tsx)
// must be able to call it before the session has ever resolved a runtime, so
// it degrades to the graceful "no URL yet" shape instead of throwing.
test('health() resolves gracefully (ok: false) before ensureReady() instead of throwing', async () => {
  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const s = k.session('PROJ', 'SESS-NEVER-STARTED');

  const result = await s.health();
  expect(result.ok).toBe(false);
  expect(result.status).toBe(0);
});

test('health() resolves against the handle\'s own runtime URL once ready', async () => {
  globalThis.fetch = mockTwoSessionRuntimes();
  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const a = k.session('PROJ', 'SESS-A');

  await a.ensureReady();
  calls.length = 0;
  await a.health();

  expect(calls.some((c) => c.url.includes('/p/sb-A/8000/kortix/health'))).toBe(true);
});

// ── shared session-runtime registry (regression: apps/whitelabel-demo's
// session-header.tsx polls health() on a FRESH `kortix.session(...)` handle
// every 15s, and preview-panel.tsx calls previewUrl() in render on a handle
// that never itself called ensureReady() — both used to throw
// SessionNotReadyError forever because a handle's `_ready` cache never
// survived past that one instance) ──────────────────────────────────────────

test('a second fresh handle for the same session adopts the registry entry — no ensureReady() of its own needed', async () => {
  globalThis.fetch = mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'POST' });
    if (url.includes('/sessions/SESS-REG-1/start')) {
      return jsonResponse(sessionStartPayload('sb-reg1', 'ocs-reg1'));
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const first = k.session('PROJ', 'SESS-REG-1');
  await first.ensureReady();

  // Brand-new handle for the SAME (projectId, sessionId) — never called ensureReady.
  const second = k.session('PROJ', 'SESS-REG-1');
  expect(second.previewUrl(4000, '/y')).toBe('http://test.local/p/sb-reg1/4000/y');

  calls.length = 0;
  const health = await second.health();
  expect(health.ok).toBe(true);
  expect(calls.some((c) => c.url.includes('/p/sb-reg1/8000/kortix/health'))).toBe(true);
});

test('restart clears the registry entry so ensureReady re-resolves the ACP runtime', async () => {
  let startCount = 0;
  globalThis.fetch = mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'POST' });
    if (url.includes('/sessions/SESS-REG-2/start')) {
      startCount += 1;
      const sandboxId = startCount === 1 ? 'sb-reg2-old' : 'sb-reg2-new';
      return jsonResponse(sessionStartPayload(sandboxId, `ocs-reg2-${startCount}`));
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const handle = k.session('PROJ', 'SESS-REG-2');

  await handle.ensureReady();
  expect(startCount).toBe(1);

  await handle.restart();

  calls.length = 0;
  await handle.ensureReady();
  expect(handle.previewUrl(3000)).toContain('/p/sb-reg2-new/3000/');
  expect(startCount).toBe(2);
});

// ── ensureReady() in-flight dedup (P0 robustness fix: two concurrent
// ensureReady() calls for the SAME (projectId, sessionId) used to both drive
// their own `/start` long-poll — a real hazard for a "Kortix as a Backend"
// server handling concurrent requests against one session) ─────────────────

test('ensureReady() dedupes concurrent starts for the same session: only one /start POST fires, both callers resolve', async () => {
  let startCalls = 0;
  let releaseStart!: (res: Response) => void;
  const deferredStart = new Promise<Response>((resolve) => {
    releaseStart = resolve;
  });

  globalThis.fetch = mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'POST' });
    if (url.includes('/sessions/SESS-DEDUP/start')) {
      startCalls += 1;
      return deferredStart;
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const handle = k.session('PROJ', 'SESS-DEDUP');

  // Fire twice concurrently, before the (deferred) /start response arrives.
  const p1 = handle.ensureReady();
  const p2 = handle.ensureReady();

  // Let both calls reach (and park at) the deferred /start request before
  // releasing it — proves they're genuinely in flight together, not just
  // sequentially resolved.
  await new Promise((r) => setTimeout(r, 0));
  releaseStart(jsonResponse(sessionStartPayload('sb-dedup', 'ocs-dedup')));

  const [r1, r2] = await Promise.all([p1, p2]);
  expect(startCalls).toBe(1); // only ONE /start POST fired for both concurrent callers
  expect(r1.sandboxId).toBe('sb-dedup');
  expect(r2.sandboxId).toBe('sb-dedup');
});

test('ensureReady() dedup also covers TWO DIFFERENT handles for the same session', async () => {
  let startCalls = 0;
  let releaseStart!: (res: Response) => void;
  const deferredStart = new Promise<Response>((resolve) => {
    releaseStart = resolve;
  });

  globalThis.fetch = mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'POST' });
    if (url.includes('/sessions/SESS-DEDUP-2/start')) {
      startCalls += 1;
      return deferredStart;
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const handleA = k.session('PROJ', 'SESS-DEDUP-2');
  const handleB = k.session('PROJ', 'SESS-DEDUP-2'); // fresh handle, same (project, session) id

  const p1 = handleA.ensureReady();
  const p2 = handleB.ensureReady();

  await new Promise((r) => setTimeout(r, 0));
  releaseStart(jsonResponse(sessionStartPayload('sb-dedup-2', 'ocs-dedup-2')));
  await Promise.all([p1, p2]);
  expect(startCalls).toBe(1);
});

test('ensureReady() clears the in-flight entry on failure, so a retry issues a fresh /start', async () => {
  let startCalls = 0;
  globalThis.fetch = mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'POST' });
    if (url.includes('/sessions/SESS-DEDUP-FAIL/start')) {
      startCalls += 1;
      // First attempt: a failure shape (no sandbox / not ready).
      if (startCalls === 1) return jsonResponse({ stage: 'failed', retriable: true, sandbox: null, runtime_session_id: null, agent_name: 'agent' });
      return jsonResponse(sessionStartPayload('sb-retry', 'ocs-retry'));
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const handle = k.session('PROJ', 'SESS-DEDUP-FAIL');

  await expect(handle.ensureReady()).rejects.toBeInstanceOf(ApiError);
  expect(startCalls).toBe(1);

  const ready = await handle.ensureReady();
  expect(ready.sandboxId).toBe('sb-retry');
  expect(startCalls).toBe(2);
});

// ── session(...).files — bound to THIS session's own runtime, never the
// module-global "active" sandbox the top-level `@kortix/sdk` `files` export
// follows (P0 fix: cross-session bleed for a host juggling multiple open
// sessions concurrently) ─────────────────────────────────────────────────────

test("session(...).files hits THIS session's own runtime URL, not whichever session is globally \"active\"", async () => {
  globalThis.fetch = mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'GET' });
    if (url.includes('/sessions/FILES-A/start')) return jsonResponse(sessionStartPayload('sb-files-a', 'ocs-files-a'));
    if (url.includes('/sessions/FILES-B/start')) return jsonResponse(sessionStartPayload('sb-files-b', 'ocs-files-b'));
    if (url.includes('/file?path=')) return jsonResponse([]);
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const a = k.session('PROJ', 'FILES-A');
  const b = k.session('PROJ', 'FILES-B');

  await a.ensureReady();
  await b.ensureReady(); // resolves LAST — the module-global "active runtime" now points at B

  calls.length = 0;
  await a.files.list('/workspace');
  const aFileCall = calls.find((c) => c.url.includes('/file?path='));
  expect(aFileCall?.url).toContain('/p/sb-files-a/8000/file');
  expect(aFileCall?.url).not.toContain('sb-files-b');

  // The module-global `files` export (used directly, not through a session
  // handle) follows the "active runtime" pointer — which B's later
  // `ensureReady()` last set. This is the documented, PRE-EXISTING behavior of
  // the global export; the point of this test is that `a.files` does NOT
  // share that behavior.
  calls.length = 0;
  await globalListFiles('/workspace');
  const globalFileCall = calls.find((c) => c.url.includes('/file?path='));
  expect(globalFileCall?.url).toContain('/p/sb-files-b/8000/file');
});

test('session(...).files auto-provisions via ensureReady() if not already ready', async () => {
  globalThis.fetch = mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'GET' });
    if (url.includes('/sessions/FILES-AUTO/start')) return jsonResponse(sessionStartPayload('sb-files-auto', 'ocs-files-auto'));
    if (url.includes('/file/mkdir')) return jsonResponse(true);
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const s = k.session('PROJ', 'FILES-AUTO');

  // Never called ensureReady() directly — mkdir should still resolve against
  // this session's own runtime.
  await s.files.mkdir('/workspace/new-dir');
  const mkdirCall = calls.find((c) => c.url.includes('/file/mkdir'));
  expect(mkdirCall?.url).toContain('/p/sb-files-auto/8000/file/mkdir');
});
