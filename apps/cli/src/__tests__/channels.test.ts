import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runChannels } from '../commands/channels.ts';
import { stripAnsi } from '../style.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
] as const;

const INSTALL_URL =
  'https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat:write&state=signed';
const TEAMS_CONSENT_URL = 'https://login.microsoftonline.com/common/adminconsent?client_id=teams-1';
const INSTALLATION = {
  workspaceId: 'T012AB3CD',
  workspaceName: 'Acme',
  botUserId: 'U0BOT',
  installedAt: '2026-07-08T00:00:00.000Z',
};
const TEAMS_INSTALLATION: {
  tenantId: string;
  catalogAppId: string | null;
  orgInstalled: boolean;
  publishState?: 'publishing' | 'published' | 'review' | 'failed' | null;
  publishError?: string | null;
  appVersion?: string | null;
  latestAppVersion?: string;
  appUpdateAvailable?: boolean;
  installedAt: string;
} = {
  tenantId: 'tid-1',
  catalogAppId: 'cat-1',
  orgInstalled: true,
  installedAt: '2026-07-08T00:00:00.000Z',
};

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
let requests: Array<{ url: string; method: string; body: any }> = [];

interface MockState {
  oauthAvailable: boolean;
  installation: typeof INSTALLATION | null;
  /** Return `installation` from the Nth GET /installation onwards (0-based). */
  installedAfterPolls?: number;
  /** The project's `teams` experimental feature, as GET /teams/mode reports it. */
  teamsEnabled: boolean;
}

let state: MockState;
let installationGets = 0;
let teamsInstall: typeof TEAMS_INSTALLATION | null = null;
let bindingsResponse: {
  projectDefaultAgent: string | null;
  bindings: Array<Record<string, unknown>>;
} | null = null;

function writeConfig(url = 'https://api.test'): void {
  const file = join(tmp, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url,
          token: 'tok_test',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  process.env.KORTIX_CONFIG_FILE = file;
}

function captureOutput() {
  stdout = '';
  stderr = '';
  (process.stdout as any).write = (chunk: unknown) => ((stdout += String(chunk)), true);
  (process.stderr as any).write = (chunk: unknown) => ((stderr += String(chunk)), true);
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockApi() {
  installationGets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: any = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url, method, body });

    if (url.includes('/channels/slack/mode')) {
      return json({
        oauth_available: state.oauthAvailable,
        install_url: state.oauthAvailable ? INSTALL_URL : null,
      });
    }
    if (url.includes('/channels/slack/installation') && method === 'GET') {
      installationGets += 1;
      if (state.installedAfterPolls !== undefined && installationGets > state.installedAfterPolls) {
        return json(INSTALLATION);
      }
      return json(state.installation);
    }
    if (url.includes('/channels/slack/installation') && method === 'DELETE') {
      return json({ status: 'disconnected' });
    }
    if (url.includes('/channels/slack/connect') && method === 'POST') {
      return json(INSTALLATION);
    }
    if (url.includes('/channels/email/mode')) {
      return json({ enabled: true, managed_available: true });
    }
    if (url.includes('/channels/email/installation')) {
      return json(null);
    }
    // Teams endpoints
    // Mirrors the real GET /channels/teams/mode payload: `enabled` is the
    // project's `teams` experiment, `available` is whether bot credentials
    // resolve. (There is no `oauth_available` field on this route.)
    if (url.includes('/channels/teams/mode')) {
      return json({
        enabled: state.teamsEnabled,
        available: state.teamsEnabled && state.oauthAvailable,
        orgConsentUrl: state.teamsEnabled && state.oauthAvailable ? TEAMS_CONSENT_URL : null,
        orgInstalled: Boolean(teamsInstall),
        deepLinkUrl: teamsInstall?.catalogAppId ?? null,
      });
    }
    if (url.includes('/channels/teams/installation') && method === 'GET') {
      return json(teamsInstall ?? null);
    }
    if (url.includes('/channels/teams/installation') && method === 'DELETE') {
      teamsInstall = null;
      return json({ status: 'disconnected' });
    }
    if (url.includes('/channels/bindings') && method === 'GET') {
      return json(bindingsResponse ?? { projectDefaultAgent: null, bindings: [] });
    }
    if (url.includes('/channels/bindings/') && method === 'PATCH') {
      const id = decodeURIComponent(url.split('/channels/bindings/')[1] ?? '');
      const row = bindingsResponse?.bindings.find((b) => b.bindingId === id);
      if (!row) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      return json({ ...row, ...JSON.parse(String(init?.body ?? '{}')) });
    }
    return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), { status: 500 });
  }) as typeof fetch;
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  process.env.KORTIX_PROJECT_ID = 'proj_1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-channels-test-'));
  process.chdir(tmp);
  writeConfig();
  captureOutput();
  requests = [];
  state = { oauthAvailable: true, installation: null, teamsEnabled: true };
  teamsInstall = null;
  bindingsResponse = null;
  mockApi();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (process.stdout as any).write = ORIGINAL_STDOUT_WRITE;
  (process.stderr as any).write = ORIGINAL_STDERR_WRITE;
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('kortix channels connect — one-click (cloud)', () => {
  test('prints the install link when OAuth is configured and nothing is connected', async () => {
    const code = await runChannels(['connect']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('Add to Slack');
    expect(out).toContain(INSTALL_URL);
    expect(out).not.toContain('kortix channels manifest');
    expect(out).not.toContain('signing secret');
    expect(requests.some((r) => r.url.includes('/channels/slack/mode'))).toBe(true);
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  test('--json emits install_url + connected:false for the agent to surface', async () => {
    const code = await runChannels(['connect', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.connected).toBe(false);
    expect(parsed.install_url).toBe(INSTALL_URL);
  });

  test('already connected → says so instead of pretending to reconnect', async () => {
    state.installation = INSTALLATION;
    const code = await runChannels(['connect']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('Already connected');
    expect(out).toContain('Acme');
  });

  test('--wait polls the installation until it lands', async () => {
    // First GET (pre-link existing check) returns null; the first poll connects.
    state.installedAfterPolls = 1;
    const code = await runChannels(['connect', '--wait', '--timeout', '30']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain(INSTALL_URL);
    expect(out).toContain('Connected to Acme');
  });
});

describe('kortix channels connect — manual (self-host)', () => {
  test('OAuth unavailable + no creds → exit 2 with the manual playbook, not a stack of API calls', async () => {
    state.oauthAvailable = false;
    const code = await runChannels(['connect']);
    expect(code).toBe(2);
    const err = stripAnsi(stderr);
    expect(err).toContain('kortix channels manifest');
    expect(err).toContain('--bot-token');
  });

  test('OAuth unavailable + env creds → posts them to /connect', async () => {
    state.oauthAvailable = false;
    process.env.SLACK_BOT_TOKEN = 'xoxb-123';
    process.env.SLACK_SIGNING_SECRET = 'sig-abc';
    const code = await runChannels(['connect']);
    expect(code).toBe(0);
    const post = requests.find(
      (r) => r.method === 'POST' && r.url.includes('/channels/slack/connect'),
    );
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({ bot_token: 'xoxb-123', signing_secret: 'sig-abc' });
    expect(stripAnsi(stdout)).toContain('Connected to Acme');
  });

  test('explicit --bot-token/--signing-secret skips the /mode lookup entirely', async () => {
    const code = await runChannels([
      'connect',
      '--bot-token',
      'xoxb-456',
      '--signing-secret',
      'sig-def',
    ]);
    expect(code).toBe(0);
    expect(requests.some((r) => r.url.includes('/channels/slack/mode'))).toBe(false);
    const post = requests.find((r) => r.method === 'POST');
    expect(post!.body).toMatchObject({ bot_token: 'xoxb-456', signing_secret: 'sig-def' });
  });

  test('--manual without creds never mints or prints an OAuth link', async () => {
    const code = await runChannels(['connect', '--manual']);
    expect(code).toBe(2);
    expect(requests.some((r) => r.url.includes('/channels/slack/mode'))).toBe(false);
    expect(stripAnsi(stdout)).not.toContain(INSTALL_URL);
  });

  test('bad bot token prefix is rejected client-side', async () => {
    const code = await runChannels([
      'connect',
      '--bot-token',
      'xoxp-oops',
      '--signing-secret',
      's',
    ]);
    expect(code).toBe(2);
    expect(stripAnsi(stderr)).toContain('xoxb-');
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });
});

describe('kortix channels status', () => {
  test('not connected → points at `kortix channels connect`', async () => {
    const code = await runChannels(['status']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('not connected');
    expect(out).toContain('kortix channels connect');
  });

  test('--json reports connected + installation', async () => {
    state.installation = INSTALLATION;
    const code = await runChannels(['status', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.connected).toBe(true);
    expect(parsed.installation.workspaceId).toBe('T012AB3CD');
  });

  test('prints one /v1 mount when the configured host already includes /v1', async () => {
    writeConfig('https://api.test/v1');
    state.installation = INSTALLATION;

    const code = await runChannels(['status']);

    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('https://api.test/v1/webhooks/slack/proj_1');
    expect(out).not.toContain('/v1/v1/');
  });
});

// Characterization for the KRTX-1334 split: `channels manifest` builds the
// Slack app manifest entirely client-side (no API call) and prints it — an
// operator pastes it into api.slack.com verbatim. Pin the whole document byte
// for byte so a restructure cannot drift a scope or the webhook URL.
describe('kortix channels manifest', () => {
  test('prints the full manifest JSON built client-side, no API call', async () => {
    const code = await runChannels(['manifest']);
    expect(code).toBe(0);
    expect(stdout).toBe(
      JSON.stringify(
        {
          display_information: {
            name: 'Kortix',
            description: 'Run a Kortix project from Slack',
            background_color: '#0a0a0a',
          },
          features: { bot_user: { display_name: 'kortix', always_online: true } },
          oauth_config: {
            scopes: {
              bot: [
                'app_mentions:read',
                'channels:history',
                'channels:read',
                'channels:join',
                'chat:write',
                'chat:write.public',
                'files:read',
                'files:write',
                'groups:history',
                'groups:read',
                'im:history',
                'im:read',
                'im:write',
                'mpim:history',
                'mpim:read',
                'reactions:read',
                'reactions:write',
                'users:read',
              ],
            },
          },
          settings: {
            event_subscriptions: {
              request_url: 'https://api.test/v1/webhooks/slack/proj_1',
              bot_events: [
                'app_mention',
                'message.im',
                'message.channels',
                'message.groups',
                'message.mpim',
                'reaction_added',
                'reaction_removed',
                'member_joined_channel',
                'file_shared',
              ],
            },
            org_deploy_enabled: false,
            socket_mode_enabled: false,
            token_rotation_enabled: false,
          },
        },
        null,
        2,
      ) + '\n',
    );
    expect(requests).toEqual([]);
  });
});

describe('kortix channels --platform teams', () => {
  test('status not connected → points at `kortix channels connect --platform teams`', async () => {
    const code = await runChannels(['status', '--platform', 'teams']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('teams');
    expect(out).toContain('not connected');
    expect(out).toContain('kortix channels connect --platform teams');
    // Must NOT hit the Slack endpoint.
    expect(requests.some((r) => r.url.includes('/channels/slack/'))).toBe(false);
    expect(requests.some((r) => r.url.includes('/channels/teams/installation'))).toBe(true);
  });

  test('status connected → shows tenant + catalog app', async () => {
    teamsInstall = TEAMS_INSTALLATION;
    const code = await runChannels(['status', '--platform', 'teams']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('tid-1');
    expect(out).toContain('cat-1');
  });

  // The one-click install binds the tenant FIRST and publishes the app to the
  // org catalog in the background. A bound-but-unpublished install is
  // connected — printing "not connected" for it (the old `!orgInstalled`
  // shortcut) sent users back to a consent flow that had already succeeded.
  test('status: tenant bound, catalog publish still running → connected + "publishing"', async () => {
    teamsInstall = {
      ...TEAMS_INSTALLATION,
      orgInstalled: false,
      catalogAppId: null,
      publishState: 'publishing',
      publishError: null,
    };
    const code = await runChannels(['status', '--platform', 'teams']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('tid-1');
    expect(out).not.toContain('not connected');
    expect(out).toContain('publishing');
  });

  test('status: catalog publish failed → connected + the Graph reason + how to retry', async () => {
    teamsInstall = {
      ...TEAMS_INSTALLATION,
      orgInstalled: false,
      catalogAppId: null,
      publishState: 'failed',
      publishError: 'Graph app-catalog publish failed (400): Invalid manifest',
    };
    const code = await runChannels(['status', '--platform', 'teams']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('tid-1');
    expect(out).not.toContain('not connected');
    expect(out).toContain('Graph app-catalog publish failed (400): Invalid manifest');
    expect(out).toContain('kortix channels connect --platform teams');
  });

  test('status: submitted for admin review → connected + "review"', async () => {
    teamsInstall = {
      ...TEAMS_INSTALLATION,
      orgInstalled: false,
      catalogAppId: 'sub-9',
      publishState: 'review',
      publishError: null,
    };
    const code = await runChannels(['status', '--platform', 'teams']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('tid-1');
    expect(out).toContain('review');
  });

  // A catalog on an app version from before the read permissions refuses
  // every thread read in a team; the fix is a publish plus an app update.
  test('status: published app older than the latest → both versions + how to update', async () => {
    teamsInstall = {
      ...TEAMS_INSTALLATION,
      publishState: 'published',
      appVersion: '1.2.0',
      latestAppVersion: '1.6.0',
      appUpdateAvailable: true,
    };
    const code = await runChannels(['status', '--platform', 'teams']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('1.2.0');
    expect(out).toContain('1.6.0');
    expect(out).toContain('kortix channels connect --platform teams');
    expect(out).toContain('team owner');
  });

  test('status: published before Kortix recorded the version or the publish state → asks for the update without a version', async () => {
    teamsInstall = {
      ...TEAMS_INSTALLATION,
      publishState: null,
      appVersion: null,
      latestAppVersion: '1.6.0',
      appUpdateAvailable: true,
    };
    const code = await runChannels(['status', '--platform', 'teams']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('1.6.0');
    expect(out).toContain('kortix channels connect --platform teams');
    expect(out).not.toContain('null');
  });

  test('status: published app on the latest version → names it, no update', async () => {
    teamsInstall = {
      ...TEAMS_INSTALLATION,
      publishState: 'published',
      appVersion: '1.6.0',
      latestAppVersion: '1.6.0',
      appUpdateAvailable: false,
    };
    const code = await runChannels(['status', '--platform', 'teams']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('app 1.6.0');
    expect(out).not.toContain('team owner');
  });

  test('status --json exposes publishState and publishError verbatim', async () => {
    teamsInstall = {
      ...TEAMS_INSTALLATION,
      orgInstalled: false,
      catalogAppId: null,
      publishState: 'failed',
      publishError: 'boom',
    };
    const code = await runChannels(['status', '--platform', 'teams', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.connected).toBe(true);
    expect(parsed.installation.publishState).toBe('failed');
    expect(parsed.installation.publishError).toBe('boom');
  });

  test('connect → prints the Microsoft admin-consent URL', async () => {
    const code = await runChannels(['connect', '--platform', 'teams']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain(TEAMS_CONSENT_URL);
    expect(out).toContain('admin consent');
    expect(requests.some((r) => r.url.includes('/channels/teams/mode'))).toBe(true);
  });

  test('connect --json → emits orgConsentUrl', async () => {
    const code = await runChannels(['connect', '--platform', 'teams', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.orgConsentUrl).toBe(TEAMS_CONSENT_URL);
    expect(parsed.orgInstalled).toBe(false);
  });

  test('connect with the `teams` feature flag off → points at Settings on stderr, not at server env vars', async () => {
    state.teamsEnabled = false;
    const code = await runChannels(['connect', '--platform', 'teams']);
    expect(code).toBe(1);
    // A rejection is an error: it belongs on stderr, worded exactly like the
    // server's feature-flag gate so both sides read identically.
    const err = stripAnsi(stderr);
    expect(err).toContain(
      'Microsoft Teams is not enabled for this project. Enable it in Settings → Feature flags.',
    );
    expect(stripAnsi(stdout)).toBe('');
    expect(err).not.toContain(TEAMS_CONSENT_URL);
    expect(err).not.toContain('MICROSOFT_APP_ID');
  });

  test('connect with the feature flag on but no bot credentials → points at the credentials', async () => {
    state.oauthAvailable = false;
    const code = await runChannels(['connect', '--platform', 'teams']);
    expect(code).toBe(1);
    const out = stripAnsi(stdout);
    expect(out).toContain('MICROSOFT_APP_ID');
    expect(out).toContain('bring your own bot');
    expect(out).not.toContain('Settings → Feature flags');
  });

  test('invalid --platform value → exit 2', async () => {
    const code = await runChannels(['status', '--platform', 'discord']);
    expect(code).toBe(2);
    expect(stripAnsi(stderr)).toContain("--platform must be 'slack' or 'teams'");
  });

  test('disconnect --platform teams DELETEs the Teams installation', async () => {
    teamsInstall = TEAMS_INSTALLATION;
    const code = await runChannels(['disconnect', '--platform', 'teams']);
    expect(code).toBe(0);
    expect(
      requests.some((r) => r.method === 'DELETE' && r.url.includes('/channels/teams/installation')),
    ).toBe(true);
    expect(stripAnsi(stdout)).toContain('Disconnected');
  });

  test('default (no --platform) still routes to Slack', async () => {
    const code = await runChannels(['status']);
    expect(code).toBe(0);
    expect(requests.some((r) => r.url.includes('/channels/slack/installation'))).toBe(true);
    expect(requests.some((r) => r.url.includes('/channels/teams/'))).toBe(false);
  });
});

// Every Slack binding on dev listed as a bare `C0…` id (2026-10-02): no Slack
// name lookup had ever succeeded. The CLI reads names the way the web does.
describe('flag-first channels dispatch', () => {
  test('dispatches --json bindings to bindings, not Slack status', async () => {
    expect(await runChannels(['--json', 'bindings'])).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ projectDefaultAgent: null, bindings: [] });
    expect(requests.some((r) => r.url.includes('/channels/slack/installation'))).toBe(false);
  });

  test('removes platform values before selecting connect', async () => {
    expect(await runChannels(['--platform', 'teams', 'connect'])).toBe(0);
    expect(stdout).toContain(TEAMS_CONSENT_URL);
    expect(requests.some((r) => r.url.includes('/channels/teams/mode'))).toBe(true);
    expect(requests.some((r) => r.url.includes('/channels/teams/installation'))).toBe(false);
  });

  test('preserves the nested email status action', async () => {
    expect(await runChannels(['--json', 'email', 'status'])).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      connected: false, mode: { enabled: true, managed_available: true }, installation: null,
    });
    expect(requests.some((r) => r.url.includes('/channels/email/mode'))).toBe(true);
  });

  test('keeps flag-only invocations on status', async () => {
    expect(await runChannels(['--json', '--platform', 'teams'])).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ connected: false, installation: null });
    expect(requests.some((r) => r.url.includes('/channels/teams/installation'))).toBe(true);
  });

  test('rejects an unknown positional subcommand after flags', async () => {
    expect(await runChannels(['--json', 'unknown'])).toBe(2);
    expect(stderr).toContain('unknown subcommand "unknown"');
    expect(requests).toEqual([]);
  });
});

describe('kortix channels bindings', () => {
  const binding = (over: Record<string, unknown>) => ({
    bindingId: 'bnd-0',
    platform: 'slack',
    workspaceId: 'T0TEST',
    channelId: 'C0TEST0',
    channelName: null,
    channelType: null,
    agentName: null,
    opencodeModel: null,
    conversationPolicy: 'project_open',
    installedAt: '2026-10-02T00:00:00.000Z',
    effectiveAgent: { agent: 'kortix', source: 'project' },
    effectiveModel: { model: null, source: 'platform' },
    ...over,
  });

  test('a Slack row reads #channel, the person of a DM, and marks a deleted channel with its id', async () => {
    bindingsResponse = {
      projectDefaultAgent: 'kortix',
      bindings: [
        binding({
          bindingId: 'bnd-1',
          channelId: 'C0TEST1',
          channelName: 'general',
          channelType: 'channel',
        }),
        binding({
          bindingId: 'bnd-2',
          channelId: 'D0TEST1',
          channelName: 'Sam Rivera',
          channelType: 'im',
        }),
        binding({ bindingId: 'bnd-3', channelId: 'C0GONE1', channelUnavailable: true }),
        binding({ bindingId: 'bnd-4', channelId: 'C0TEST4' }),
      ],
    };
    const code = await runChannels(['bindings']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('#general');
    expect(out).toContain('Sam Rivera');
    expect(out).not.toContain('#Sam Rivera');
    expect(out).toContain('unavailable (C0GONE1)');
    expect(out).toContain('C0TEST4');
  });

  test('bind confirms the change by the name the list shows', async () => {
    bindingsResponse = {
      projectDefaultAgent: 'kortix',
      bindings: [
        binding({
          bindingId: 'bnd-1',
          channelId: 'C0TEST1',
          channelName: 'general',
          channelType: 'channel',
        }),
        binding({
          bindingId: 'bnd-2',
          channelId: 'D0TEST1',
          channelName: 'Sam Rivera',
          channelType: 'im',
        }),
      ],
    };
    expect(await runChannels(['bind', 'bnd-1', '--agent', 'reviewer'])).toBe(0);
    expect(stripAnsi(stdout)).toContain('#general updated');

    stdout = '';
    expect(await runChannels(['bind', 'bnd-2', '--agent', 'reviewer'])).toBe(0);
    expect(stripAnsi(stdout)).toContain('Sam Rivera updated');
    expect(stripAnsi(stdout)).not.toContain('#Sam Rivera');
  });
});
