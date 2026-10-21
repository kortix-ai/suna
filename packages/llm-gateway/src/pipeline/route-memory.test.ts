import { expect, test } from 'bun:test';
import type { AuthedPrincipal, GatewayTrace, ModelFallbackCondition, UpstreamDescriptor } from '../domain';
import { GatewayResolutionError } from '../errors';
import { createRouteMemory } from './route-memory';
import { handleChatCompletions } from './simple-handler';

const upstream = (model: string, billingMode: 'none' | 'credits'): UpstreamDescriptor => ({
  provider: `${model}-upstream`, kind: 'openai-compat', baseUrl: `https://${model}.example/v1`,
  apiKey: 'key', billingMode, markup: billingMode === 'none' ? 0 : 1,
  pricing: { inputPerMillion: 1, outputPerMillion: 2 },
});
const ok = () => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const resting = () => {
  throw new GatewayResolutionError('provider_pool_rate_limited', 'All ChatGPT connections are resting.', 'Wait.', 300);
};

/** One gateway with a fake clock. Each `send` is one request of `sessionId`. */
function gateway(options: {
  policyId: string;
  fallbackOn?: ModelFallbackCondition;
  primary: () => UpstreamDescriptor[];
  respond: (host: string) => Response;
}) {
  let clock = 1_000_000;
  const routeMemory = createRouteMemory(() => clock);
  const resolved: string[] = [];
  const fetched: string[] = [];
  const traces: GatewayTrace[] = [];
  const send = async (sessionId = 'session-1') => {
    const principal: AuthedPrincipal = { userId: 'user', accountId: 'account', projectId: 'project', sessionId };
    const response = await handleChatCompletions({
      hooks: {
        authenticate: async () => principal,
        authorize: async () => ({ ok: true, principal }),
        resolveRoute: async () => ({
          policyId: options.policyId, primaryModel: 'primary', fallbackModels: ['fallback'],
          fallbackOn: options.fallbackOn ?? 'transient',
        }),
        resolveUpstream: async (_principal, model) => {
          resolved.push(model);
          return model === 'primary' ? options.primary() : [upstream('fallback', 'credits')];
        },
        assertBillingActive: async () => {},
        recordUsage: async () => {},
        recordTrace: async (trace) => { traces.push(trace); },
      },
      logger: { info() {}, warn() {}, error() {} },
      routeMemory,
      fetchImpl: async (url) => {
        const host = new URL(url).host.split('.')[0]!;
        fetched.push(host);
        return options.respond(host);
      },
    }, { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'primary', messages: [] }) });
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { status: response.status, trace: traces.at(-1)! };
  };
  const reset = () => { resolved.length = 0; fetched.length = 0; };
  return { send, resolved, fetched, reset, advance: (seconds: number) => { clock += seconds * 1000; } };
}

test('a resting ChatGPT pool is resolved once per hold, not on every request of the session', async () => {
  const gw = gateway({ policyId: 'project:default', primary: resting, respond: ok });
  expect((await gw.send()).trace.attemptFailures?.[0]).toMatchObject({ stage: 'resolve', code: 'provider_pool_rate_limited' });
  gw.reset();

  const held = await gw.send();
  expect(held.status).toBe(200);
  expect(gw.resolved).toEqual(['fallback']);
  expect(held.trace).toMatchObject({ servedModel: 'fallback', fallbackFrom: 'primary' });
  expect(held.trace.attemptFailures?.[0]).toMatchObject({ stage: 'held', code: 'provider_pool_rate_limited', status: 429 });

  // Another session of the same project learns it on its own request.
  gw.reset();
  await gw.send('session-2');
  expect(gw.resolved).toEqual(['primary', 'fallback']);

  // The pool reported 300 s: after that the routed model is resolved first again.
  gw.advance(301);
  gw.reset();
  await gw.send();
  expect(gw.resolved).toEqual(['primary', 'fallback']);
});

test('a usage limit with no retry hint is held for its reset, not the 600 s cap', async () => {
  const gw = gateway({
    policyId: 'project:default',
    primary: () => {
      throw new GatewayResolutionError('provider_pool_rate_limited', 'Resting.', 'Wait.', undefined, 180);
    },
    respond: ok,
  });
  expect((await gw.send()).trace.attemptFailures?.[0]).toMatchObject({ stage: 'resolve', holdSeconds: 180 });
  gw.advance(181);
  gw.reset();
  await gw.send();
  expect(gw.resolved).toEqual(['primary', 'fallback']);
});

test('a busy managed model is skipped for the hold after a fallback answered', async () => {
  const gw = gateway({
    policyId: 'platform-default-resilience',
    primary: () => [upstream('primary', 'credits')],
    respond: (host) => (host === 'primary' ? new Response('busy', { status: 503 }) : ok()),
  });
  await gw.send();
  expect(gw.fetched).toEqual(['primary', 'fallback']);
  gw.reset();

  await gw.send();
  expect(gw.fetched).toEqual(['fallback']);

  gw.advance(61);
  gw.reset();
  await gw.send();
  expect(gw.fetched).toEqual(['primary', 'fallback']);
});

test('a held request whose fallback fails tries the routed model last, and its answer releases the hold', async () => {
  let fallbackUp = true;
  let primaryBusy = true;
  const gw = gateway({
    policyId: 'platform-default-resilience',
    primary: () => [upstream('primary', 'credits')],
    respond: (host) => {
      if (host === 'fallback') return fallbackUp ? ok() : new Response('down', { status: 503 });
      return primaryBusy ? new Response('busy', { status: 503 }) : ok();
    },
  });
  await gw.send();
  fallbackUp = false;
  primaryBusy = false;
  gw.reset();

  const rescued = await gw.send();
  expect(rescued.status).toBe(200);
  expect(gw.fetched).toEqual(['fallback', 'primary']);
  expect(rescued.trace.servedModel).toBe('primary');

  gw.reset();
  await gw.send();
  expect(gw.fetched).toEqual(['primary']);
});

test('a request-specific 400 that an any-error chain rescued does not hold the route', async () => {
  const gw = gateway({
    policyId: 'project:default',
    fallbackOn: 'any-error',
    primary: () => [upstream('primary', 'none')],
    respond: (host) => (host === 'primary' ? new Response('bad request', { status: 400 }) : ok()),
  });
  await gw.send();
  gw.reset();
  await gw.send();
  expect(gw.fetched).toEqual(['primary', 'fallback']);
});
