import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import type { ConnectionShare } from './connectors';
import type {
  ProjectSecretsAgentScope,
  SecretDeliveryBlockedReason,
  SecretEgressPolicy,
  SecretSharePrincipal,
} from './secrets';
import {
  brokerProjectSecretRequest,
  deletePersonalProjectSecret,
  deleteProjectProviderOAuth,
  deleteProjectSecret,
  listProjectProviderOAuth,
  listProjectSecrets,
  pollProjectProviderOAuth,
  runProjectProviderOAuthFlow,
  setPersonalProjectSecret,
  setProjectSecretStrategy,
  startProjectProviderOAuth,
  upsertProjectGitCredential,
  upsertProjectSecret,
} from './secrets';

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

test('listProjectSecrets hits GET /projects/:id/secrets and returns the parsed body', async () => {
  nextResponse = { status: 200, body: { items: [], required: [], optional: [] } };
  const result = await listProjectSecrets('P1');
  expect(last().url).toContain('/projects/P1/secrets');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ items: [], required: [], optional: [] });
});

test('listProjectSecrets throws when the response is unsuccessful', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(listProjectSecrets('P1')).rejects.toBeTruthy();
});

test('listProjectSecrets is a silent background read — a 403 never hits the global error sink', async () => {
  // project.secret.read is manager-tier: plain members legitimately 403 from
  // member-visible surfaces (model picker, LLM providers). No global toast.
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  try {
    nextResponse = { status: 403, body: { message: 'forbidden' } };
    await expect(listProjectSecrets('P1')).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});

test('upsertProjectSecret POSTs name/value as the raw body', async () => {
  nextResponse = { status: 200, body: { name: 'FOO' } };
  await upsertProjectSecret('P1', { name: 'FOO', value: 'bar' });
  expect(last().url).toContain('/projects/P1/secrets');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ name: 'FOO', value: 'bar' });
});

test('upsertProjectSecret includes an explicit identifier when given', async () => {
  nextResponse = { status: 200, body: { name: 'FOO' } };
  await upsertProjectSecret('P1', { name: 'FOO', identifier: 'GMAPS-backup', value: 'bar' });
  expect(last().body).toEqual({ name: 'FOO', identifier: 'GMAPS-backup', value: 'bar' });
});

test('upsertProjectSecret sends who can use the value as shared_with ([] = everyone)', async () => {
  nextResponse = { status: 200, body: { name: 'DEEL_API_TOKEN' } };
  await upsertProjectSecret('P1', {
    name: 'DEEL_API_TOKEN',
    value: 'token',
    shared_with: [{ principal_type: 'user', principal_id: 'U1' }],
  });
  expect(last().body).toEqual({
    name: 'DEEL_API_TOKEN',
    value: 'token',
    shared_with: [{ principal_type: 'user', principal_id: 'U1' }],
  });
  await upsertProjectSecret('P1', { name: 'DEEL_API_TOKEN', shared_with: [] });
  expect(last().body).toEqual({ name: 'DEEL_API_TOKEN', shared_with: [] });
});

test('upsertProjectSecret can share a value with an agent (its service account)', async () => {
  nextResponse = { status: 200, body: { name: 'NIGHTLY_REPORT_KEY' } };
  const shared_with: SecretSharePrincipal[] = [{ principal_type: 'agent', principal_id: 'SA1' }];
  await upsertProjectSecret('P1', { name: 'NIGHTLY_REPORT_KEY', shared_with });
  expect(last().body).toEqual({ name: 'NIGHTLY_REPORT_KEY', shared_with });
  const agentShare: ConnectionShare = {
    grant_id: 'G2',
    principal_type: 'agent',
    principal_id: 'SA1',
    label: 'reporter',
    expires_at: null,
  };
  expect(agentShare.principal_type).toBe('agent');
});

test("listProjectSecrets returns each value's audience and whether the caller can use it", async () => {
  const share = {
    grant_id: 'G1',
    principal_type: 'member' as const,
    principal_id: 'U1',
    label: 'a@example.test',
    expires_at: null,
  };
  nextResponse = {
    status: 200,
    body: {
      items: [{ identifier: 'DEEL_API_TOKEN', shared_with: [share], usable: false }],
      required: [],
      optional: [],
    },
  };
  const res = await listProjectSecrets('P1');
  const item = res.items[0]!;
  const sharedWith: ConnectionShare[] | undefined = item.shared_with;
  const usable: boolean | undefined = item.usable;
  expect(sharedWith).toEqual([share]);
  expect(usable).toBe(false);
});

test('upsertProjectSecret sends an explicit server consumer without a plaintext transition', async () => {
  nextResponse = { status: 200, body: { name: 'OPENAI_API_KEY' } };
  await upsertProjectSecret('P1', {
    name: 'OPENAI_API_KEY',
    value: 'key',
    strategy: 'broker',
    consumer: 'llm_gateway',
  });
  expect(last().body).toEqual({
    name: 'OPENAI_API_KEY',
    value: 'key',
    strategy: 'broker',
    consumer: 'llm_gateway',
  });
});

test('setProjectSecretStrategy PUTs the strategy to the encoded identifier route', async () => {
  nextResponse = {
    status: 200,
    body: {
      identifier: 'API/key',
      name: 'API_KEY',
      strategy: 'denied',
      delivery_status: 'disabled',
    },
  };

  const result = await setProjectSecretStrategy('P1', 'API/key', 'denied');

  expect(last().url).toContain('/projects/P1/secrets/API%2Fkey/strategy');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ strategy: 'denied' });
  expect(result.strategy).toBe('denied');
});

test('setProjectSecretStrategy sends broker policy options', async () => {
  nextResponse = { status: 200, body: { identifier: 'API_KEY', strategy: 'broker' } };

  await setProjectSecretStrategy('P1', 'API_KEY', 'broker', {
    consumer: 'http_broker',
    egress_policy: {
      backend: 'kortix_fetch',
      rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
      inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
    },
    handle_prefix: 'example_',
  });

  expect(last().body).toEqual({
    strategy: 'broker',
    consumer: 'http_broker',
    egress_policy: {
      backend: 'kortix_fetch',
      rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
      inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
    },
    handle_prefix: 'example_',
  });
});

test('brokerProjectSecretRequest POSTs a policy-bound HTTPS request', async () => {
  nextResponse = {
    status: 200,
    body: { status: 201, headers: { 'content-type': 'application/json' }, body_base64: 'e30=' },
  };

  const result = await brokerProjectSecretRequest('P1', 'primary/key', {
    url: 'https://api.example.com/v1/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body_base64: 'e30=',
  });

  expect(last()).toMatchObject({
    method: 'POST',
    url: expect.stringContaining('/projects/P1/secrets/primary%2Fkey/broker'),
    body: {
      url: 'https://api.example.com/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body_base64: 'e30=',
    },
  });
  expect(result.status).toBe(201);
});

test('listProjectProviderOAuth returns the connected provider logins', async () => {
  const items = [
    { provider_id: 'opencode-go', expires_in_ms: 1000, updated_at: '2026-10-01T00:00:00.000Z' },
  ];
  nextResponse = { status: 200, body: { items } };
  const result = await listProjectProviderOAuth('P1');
  expect(last().url).toContain('/projects/P1/oauth');
  expect(last().url.endsWith('/oauth')).toBe(true);
  expect(last().method).toBe('GET');
  expect(result).toEqual(items);
});

test('startProjectProviderOAuth posts to the provider start endpoint with the sharing intent', async () => {
  nextResponse = {
    status: 200,
    body: {
      flow_id: 'f1',
      verification_url: 'https://x',
      user_code: '123',
      expires_at: 1,
      interval_ms: 500,
    },
  };
  const result = await startProjectProviderOAuth('P1', 'chatgpt', { sharing: { mode: 'project' } });
  expect(last().url).toContain('/projects/P1/oauth/chatgpt/start');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ sharing: { mode: 'project' } });
  expect(result.flow_id).toBe('f1');
});

test('startProjectProviderOAuth sends sharing: undefined when no input is given', async () => {
  nextResponse = {
    status: 200,
    body: { flow_id: 'f1', verification_url: 'x', user_code: null, expires_at: 1, interval_ms: 1 },
  };
  await startProjectProviderOAuth('P1', 'chatgpt');
  expect(last().body).toEqual({ sharing: undefined });
});

test('startProjectProviderOAuth sends a named account resource request', async () => {
  nextResponse = {
    status: 200,
    body: {
      flow_id: 'flow',
      verification_url: 'https://example.test',
      user_code: 'ABCD',
      expires_at: 1,
      interval_ms: 3000,
    },
  };
  await startProjectProviderOAuth('P1', 'openai', { resourceLabel: 'My ChatGPT' });
  expect(last().body).toMatchObject({ resource_label: 'My ChatGPT' });
});

test('startProjectProviderOAuth reconnects an existing account resource by id alone', async () => {
  nextResponse = {
    status: 200,
    body: {
      flow_id: 'flow',
      verification_url: 'https://example.test',
      user_code: 'ABCD',
      expires_at: 1,
      interval_ms: 3000,
    },
  };
  await startProjectProviderOAuth('P1', 'openai', {
    resourceId: '77777777-7777-4777-8777-777777777777',
  });
  expect(last().url).toContain('/projects/P1/oauth/openai/start');
  // Reconnect keeps the label and access: nothing but the id is sent.
  expect(last().body).toEqual({
    sharing: undefined,
    resource_id: '77777777-7777-4777-8777-777777777777',
  });
});

test('pollProjectProviderOAuth posts the flow_id and returns the poll result', async () => {
  nextResponse = { status: 200, body: { status: 'pending', next_poll_ms: 2000 } };
  const result = await pollProjectProviderOAuth('P1', 'chatgpt', 'flow-123');
  expect(last().url).toContain('/projects/P1/oauth/chatgpt/poll');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ flow_id: 'flow-123' });
  expect(result).toEqual({ status: 'pending', next_poll_ms: 2000 });
});

test('upsertProjectGitCredential PUTs the token to /git-credential', async () => {
  nextResponse = {
    status: 200,
    body: { configured: true, provider: 'github', git_connection: {} },
  };
  const result = await upsertProjectGitCredential('P1', { token: 'ghp_abc' });
  expect(last().url).toContain('/projects/P1/git-credential');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ token: 'ghp_abc' });
  expect(result.configured).toBe(true);
});

test('deleteProjectSecret DELETEs the encoded secret name', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteProjectSecret('P1', 'MY KEY');
  expect(last().url).toContain('/projects/P1/secrets/MY%20KEY');
  expect(last().method).toBe('DELETE');
});

test('deleteProjectProviderOAuth DELETEs the encoded provider', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteProjectProviderOAuth('P1', 'openai/codex');
  expect(last().url).toContain('/projects/P1/oauth/openai%2Fcodex');
  expect(last().method).toBe('DELETE');
});

test('setPersonalProjectSecret PUTs to the /personal sub-route', async () => {
  nextResponse = {
    status: 200,
    body: { name: 'FOO', mine: { active: true, updated_at: '2026-01-01' } },
  };
  await setPersonalProjectSecret('P1', 'FOO', { value: 'mine-value', active: true });
  expect(last().url).toContain('/projects/P1/secrets/FOO/personal');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ value: 'mine-value', active: true });
});

test('deletePersonalProjectSecret DELETEs the /personal sub-route', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deletePersonalProjectSecret('P1', 'FOO');
  expect(last().url).toContain('/projects/P1/secrets/FOO/personal');
  expect(last().method).toBe('DELETE');
});

test('deletePersonalProjectSecret encodes special characters in the secret name', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deletePersonalProjectSecret('P1', 'FOO/BAR');
  expect(last().url).toContain('/projects/P1/secrets/FOO%2FBAR/personal');
});

// The server answers "can this secret actually be delivered?" on two separate
// axes and an SDK consumer needs both: `delivery_status` is the deployment's
// verdict on the chosen path, `delivery_blocked_reason` is the agent-grant
// verdict, and `network_boundary_available` is why an `egress` path is dead.
// Both of the latter two were declared on the wire and absent from this type
// for long enough that no host could explain an undeliverable secret.
test('listProjectSecrets surfaces both delivery axes an egress secret depends on', async () => {
  nextResponse = {
    status: 200,
    body: {
      items: [
        {
          identifier: 'STRIPE_KEY',
          name: 'STRIPE_KEY',
          strategy: 'egress',
          consumer: 'network',
          delivery_status: 'unavailable',
          delivery_blocked_reason: 'no_agent_grant',
          network_boundary_available: false,
        },
      ],
      required: [],
      optional: [],
    },
  };

  const [secret] = (await listProjectSecrets('P1')).items;

  const blockedReason: SecretDeliveryBlockedReason | null | undefined =
    secret?.delivery_blocked_reason;
  const boundaryAvailable: boolean | undefined = secret?.network_boundary_available;
  expect(blockedReason).toBe('no_agent_grant');
  expect(boundaryAvailable).toBe(false);
});

test('a deliverable boundary secret reports the boundary present and no grant block', async () => {
  nextResponse = {
    status: 200,
    body: {
      items: [
        {
          identifier: 'STRIPE_KEY',
          name: 'STRIPE_KEY',
          strategy: 'egress',
          consumer: 'network',
          delivery_status: 'available',
          delivery_blocked_reason: null,
          network_boundary_available: true,
        },
      ],
      required: [],
      optional: [],
    },
  };

  const [secret] = (await listProjectSecrets('P1')).items;

  expect(secret?.delivery_blocked_reason).toBeNull();
  expect(secret?.network_boundary_available).toBe(true);
});

test('an older server that omits both fields still parses', async () => {
  nextResponse = {
    status: 200,
    body: {
      items: [{ identifier: 'API_KEY', name: 'API_KEY', strategy: 'runtime', consumer: 'sandbox' }],
      required: [],
      optional: [],
    },
  };

  const [secret] = (await listProjectSecrets('P1')).items;

  expect(secret?.delivery_blocked_reason).toBeUndefined();
  expect(secret?.network_boundary_available).toBeUndefined();
});

// An egress-enforced secret is served by HANDLE SUBSTITUTION: the sandbox env
// carries a handle, the relay swaps it for the real value on an approved host,
// and the policy is nothing but a host list. `inject` names a slot only for
// legacy rows, so a host-list-only policy has to typecheck and has to reach the
// wire unchanged.
test('setProjectSecretStrategy sends a host-list-only egress policy (no inject slot)', async () => {
  const egress_policy: SecretEgressPolicy = {
    rules: [{ host: 'api.stripe.com' }],
    on_no_match: 'deny',
  };
  expect(egress_policy.inject).toBeUndefined();

  await setProjectSecretStrategy('P1', 'STRIPE_KEY', 'egress', {
    consumer: 'network',
    egress_policy,
  });

  expect(last().method).toBe('PUT');
  expect(last().url).toContain('/projects/P1/secrets/STRIPE_KEY/strategy');
  expect(last().body).toEqual({
    strategy: 'egress',
    consumer: 'network',
    egress_policy: { rules: [{ host: 'api.stripe.com' }], on_no_match: 'deny' },
  });
});

test('setProjectSecretStrategy still sends a legacy policy that carries an inject slot', async () => {
  const egress_policy: SecretEgressPolicy = {
    rules: [{ host: 'api.stripe.com' }],
    inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
    on_no_match: 'deny',
  };

  await setProjectSecretStrategy('P1', 'STRIPE_KEY', 'egress', {
    consumer: 'network',
    egress_policy,
  });

  expect((last().body as { egress_policy: SecretEgressPolicy }).egress_policy.inject).toEqual({
    kind: 'header',
    name: 'authorization',
    template: 'Bearer {{secret}}',
  });
});

test('listProjectSecrets surfaces the calling agent own secrets grant', async () => {
  nextResponse = {
    status: 200,
    body: {
      items: [],
      required: ['API_KEY'],
      optional: [],
      agent_scope: { agent: 'analyst', secrets: ['OTHER_KEY'] },
    },
  };

  const scope: ProjectSecretsAgentScope | null | undefined = (await listProjectSecrets('P1'))
    .agent_scope;
  expect(scope).toEqual({ agent: 'analyst', secrets: ['OTHER_KEY'] });
});

// ── runProjectProviderOAuthFlow: the device-flow orchestration ──────────────
//
// The web hook used to own the start/poll loop (2 s floor, 3 s fallback
// cadence, 10 min fallback deadline, transient poll retry, cancellation
// checkpoints). These tests pin that orchestration on a fake clock so the
// behavior survives the move verbatim.

const startBody = {
  flow_id: 'flow-1',
  verification_url: 'https://example.test/device',
  user_code: 'ABCD-1234',
  expires_at: Number.MAX_SAFE_INTEGER,
  interval_ms: 5_000,
};

type ScriptStep = { status: number; body: unknown; side?: () => void };

/** A fetch that answers from `script` in order and records every call. */
function scriptedFetch() {
  const script: ScriptStep[] = [];
  configureKortix({
    backendUrl: 'http://test.local',
    getToken: async () => 'tok',
    fetch: async (url, opts = {}) => {
      calls.push({
        url: String(url),
        method: opts.method ?? 'GET',
        body: typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined,
      });
      const step = script.shift();
      if (!step) throw new Error(`unexpected fetch: ${String(url)}`);
      step.side?.();
      return new Response(JSON.stringify(step.body), {
        status: step.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return script;
}

function fakeClock() {
  const sleeps: number[] = [];
  let nowMs = 1_000;
  return {
    sleeps,
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  };
}

const startRoute = 'http://test.local/projects/P1/oauth/openai/start';
const pollRoute = 'http://test.local/projects/P1/oauth/openai/poll';
const patch = (method: string, url: string) =>
  calls.filter((call) => call.method === method && call.url === url).length;

test('runProjectProviderOAuthFlow resolves the challenge before the first poll', async () => {
  const script = scriptedFetch();
  script.push({ status: 200, body: startBody });
  script.push({ status: 200, body: { status: 'pending' } });
  script.push({
    status: 200,
    body: {
      status: 'success',
      credential: { provider_id: 'codex', expires_in_ms: null, updated_at: 't' },
    },
  });
  const clock = fakeClock();
  const challenges: unknown[] = [];
  const result = await runProjectProviderOAuthFlow({
    projectId: 'P1',
    provider: 'openai',
    onChallenge: (challenge) => {
      expect(patch('POST', pollRoute)).toBe(0);
      challenges.push(challenge);
    },
    ...clock,
  });
  expect(result).toEqual({
    status: 'success',
    credential: { provider_id: 'codex', expires_in_ms: null, updated_at: 't' },
  });
  expect(challenges).toEqual([
    { verification_url: 'https://example.test/device', user_code: 'ABCD-1234' },
  ]);
  // start → poll: the challenge callback ran before any poll request.
  expect(calls[0]?.url).toBe(startRoute);
  expect(calls[1]?.url).toBe(pollRoute);
  expect(patch('POST', pollRoute)).toBe(2);
  expect(clock.sleeps).toEqual([5_000, 5_000]);
});

test('runProjectProviderOAuthFlow retries a transient poll failure and then succeeds', async () => {
  const script = scriptedFetch();
  script.push({ status: 200, body: startBody });
  script.push({ status: 500, body: { message: 'upstream blip' } });
  script.push({ status: 200, body: { status: 'pending' } });
  script.push({
    status: 200,
    body: {
      status: 'success',
      credential: { provider_id: 'codex', expires_in_ms: null, updated_at: 't' },
    },
  });
  const clock = fakeClock();
  const result = await runProjectProviderOAuthFlow({
    projectId: 'P1',
    provider: 'openai',
    ...clock,
  });
  expect(result.status).toBe('success');
  expect(patch('POST', pollRoute)).toBe(3);
  expect(clock.sleeps).toEqual([5_000, 5_000, 5_000]);
});

test('runProjectProviderOAuthFlow maps failed and expired polls and stops polling', async () => {
  {
    calls.length = 0;
    const script = scriptedFetch();
    script.push({ status: 200, body: startBody });
    script.push({ status: 200, body: { status: 'failed', error: 'The user denied the request' } });
    const clock = fakeClock();
    const result = await runProjectProviderOAuthFlow({
      projectId: 'P1',
      provider: 'openai',
      ...clock,
    });
    expect(result).toEqual({ status: 'failed', error: 'The user denied the request' });
    expect(patch('POST', pollRoute)).toBe(1);
  }
  {
    calls.length = 0;
    const script = scriptedFetch();
    script.push({ status: 200, body: startBody });
    script.push({ status: 200, body: { status: 'expired' } });
    const clock = fakeClock();
    const result = await runProjectProviderOAuthFlow({
      projectId: 'P1',
      provider: 'openai',
      ...clock,
    });
    expect(result).toEqual({ status: 'expired' });
    expect(patch('POST', pollRoute)).toBe(1);
  }
});

test('runProjectProviderOAuthFlow floors the cadence at 2s and falls back to 3s', async () => {
  // A server suggestion below the floor is raised to the floor.
  {
    const script = scriptedFetch();
    script.push({ status: 200, body: { ...startBody, interval_ms: 100 } });
    script.push({
      status: 200,
      body: {
        status: 'success',
        credential: { provider_id: 'codex', expires_in_ms: null, updated_at: 't' },
      },
    });
    const clock = fakeClock();
    await runProjectProviderOAuthFlow({ projectId: 'P1', provider: 'openai', ...clock });
    expect(clock.sleeps).toEqual([2_000]);
  }
  // No suggestion falls back to 3s.
  {
    const script = scriptedFetch();
    script.push({ status: 200, body: { ...startBody, interval_ms: 0 } });
    script.push({
      status: 200,
      body: {
        status: 'success',
        credential: { provider_id: 'codex', expires_in_ms: null, updated_at: 't' },
      },
    });
    const clock = fakeClock();
    await runProjectProviderOAuthFlow({ projectId: 'P1', provider: 'openai', ...clock });
    expect(clock.sleeps).toEqual([3_000]);
  }
});

test('runProjectProviderOAuthFlow times out at the 10-minute fallback deadline when start sends no expiry', async () => {
  const script = scriptedFetch();
  script.push({ status: 200, body: { ...startBody, expires_at: 0, interval_ms: 0 } });
  for (let i = 0; i < 200; i++) script.push({ status: 200, body: { status: 'pending' } });
  const clock = fakeClock();
  const result = await runProjectProviderOAuthFlow({
    projectId: 'P1',
    provider: 'openai',
    ...clock,
  });
  expect(result).toEqual({ status: 'expired' });
  // 1s in, then 3s per tick from the fallback: the 200th tick's poll lands at
  // 598s, inside the 600s deadline; the next loop check is at 601s — out.
  expect(patch('POST', pollRoute)).toBe(200);
  expect(clock.sleeps).toHaveLength(200);
});

test('runProjectProviderOAuthFlow honours the expiry the server sends', async () => {
  const script = scriptedFetch();
  // expires_at = now + 5s: one 3s wait, one poll at +3s (pending), one poll
  // at +6s would be past the deadline, so the flow stops at two polls.
  script.push({ status: 200, body: { ...startBody, interval_ms: 3_000, expires_at: 6_000 } });
  script.push({ status: 200, body: { status: 'pending' } });
  script.push({ status: 200, body: { status: 'pending' } });
  const clock = fakeClock();
  const result = await runProjectProviderOAuthFlow({
    projectId: 'P1',
    provider: 'openai',
    ...clock,
  });
  expect(result).toEqual({ status: 'expired' });
  expect(patch('POST', pollRoute)).toBe(2);
});

test('runProjectProviderOAuthFlow can be cancelled after start, during the wait, and after a poll', async () => {
  // Cancelled right after start: no poll at all.
  {
    calls.length = 0;
    const script = scriptedFetch();
    script.push({ status: 200, body: startBody });
    const clock = fakeClock();
    const result = await runProjectProviderOAuthFlow({
      projectId: 'P1',
      provider: 'openai',
      isCancelled: () => true,
      ...clock,
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(patch('POST', pollRoute)).toBe(0);
  }
  // Cancelled during the wait: the flow wakes and stops before polling.
  {
    calls.length = 0;
    const script = scriptedFetch();
    script.push({ status: 200, body: startBody });
    const clock = fakeClock();
    let cancelled = false;
    const result = await runProjectProviderOAuthFlow({
      projectId: 'P1',
      provider: 'openai',
      isCancelled: () => cancelled,
      sleep: async (ms) => {
        cancelled = true;
        clock.sleeps.push(ms);
      },
      now: clock.now,
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(patch('POST', pollRoute)).toBe(0);
  }
  // Cancelled after a successful poll: the credential is discarded.
  {
    calls.length = 0;
    const script = scriptedFetch();
    script.push({ status: 200, body: startBody });
    script.push({
      status: 200,
      body: {
        status: 'success',
        credential: { provider_id: 'codex', expires_in_ms: null, updated_at: 't' },
      },
      side: () => {
        cancelledAfterPoll = true;
      },
    });
    const clock = fakeClock();
    let cancelledAfterPoll = false;
    const result = await runProjectProviderOAuthFlow({
      projectId: 'P1',
      provider: 'openai',
      isCancelled: () => cancelledAfterPoll,
      ...clock,
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(patch('POST', pollRoute)).toBe(1);
  }
});

test('runProjectProviderOAuthFlow lets start failures propagate', async () => {
  const script = scriptedFetch();
  script.push({ status: 403, body: { message: 'forbidden' } });
  const clock = fakeClock();
  await expect(
    runProjectProviderOAuthFlow({ projectId: 'P1', provider: 'openai', ...clock }),
  ).rejects.toBeTruthy();
  expect(patch('POST', pollRoute)).toBe(0);
});
