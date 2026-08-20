/**
 * Agent sessions cannot set a secret's DELIVERY POLICY (FINDING 6).
 *
 * PUT /:projectId/secrets/:identifier/strategy already refuses an agent-session
 * token outright: `if (getAgentGrant(c)) return 403`. But three sibling routes
 * could change the same delivery control while gating on the IAM
 * PROJECT_SECRET_WRITE leaf alone:
 *
 *   POST /:projectId/secrets  — an agent PAT could create/overwrite a secret
 *        with `strategy`/`consumer`/`egress_policy`, WIDENING a host list that a
 *        later session mints a spendable handle against (the exfil vector).
 *   DELETE /:projectId/secrets/:name — deleting a policy-bearing (non-runtime)
 *        secret is a policy-affecting operation.
 *   POST /:projectId/secrets/sync — force-re-mints every handle into active
 *        sandboxes: the re-mint half of the policy-widening chain.
 *
 * These assert on the SOURCE of each handler rather than by driving the route:
 * r3.ts is a single 1.9k-line OpenAPI registration file with no per-route
 * export to import, and standing up the app pulls in the whole API and a live
 * DB. The assertions are scoped to each handler's own body and check ORDERING —
 * a gate that runs after the thing it protects is not a gate. This mirrors the
 * r4-question-authz.test.ts pattern. End-to-end HTTP proof (agent PAT → 403,
 * full-IAM user → 200) is exercised by tests/src/flows/secrets.flow.ts.
 */
import { describe, expect, test } from 'bun:test';

const SRC = await Bun.file(new URL('./r3.ts', import.meta.url).pathname).text();

const GUARD_MESSAGE = 'Agent sessions cannot change secret delivery policy';

/**
 * The body of one `projectsApp.openapi(...)` registration, selected by HTTP
 * method + path. Scoping matters: r3.ts registers many secret handlers, so a
 * whole-file substring match would pass on a neighbour's gate. The path check
 * carries its closing quote so `/{projectId}/secrets` does not match
 * `/{projectId}/secrets/sync`.
 */
function handlerSource(method: string, path: string): string {
  const blocks = SRC.split('projectsApp.openapi(');
  const match = blocks.find(
    (b) => b.includes(`method: '${method}'`) && b.includes(`path: '${path}'`),
  );
  if (!match) throw new Error(`no ${method.toUpperCase()} ${path} handler found in r3.ts`);
  return match;
}

describe('PUT strategy is the reference guard', () => {
  const src = handlerSource('put', '/{projectId}/secrets/{identifier}/strategy');

  test('refuses agent-session tokens with the shared message', () => {
    expect(src).toContain('getAgentGrant(c)');
    expect(src).toContain(GUARD_MESSAGE);
    expect(src).toContain('403');
  });
});

describe('POST /:projectId/secrets', () => {
  const src = handlerSource('post', '/{projectId}/secrets');

  test('refuses an agent session that supplies a non-default delivery policy', () => {
    expect(src).toContain('getAgentGrant(c)');
    expect(src).toContain(GUARD_MESSAGE);
    // The guard fires on any of strategy!=runtime, consumer!=sandbox, or an
    // egress_policy — the three delivery-policy inputs.
    expect(src).toContain("requestedStrategy !== 'runtime'");
    expect(src).toContain("requestedConsumerData !== 'sandbox'");
    expect(src).toContain('body.egress_policy !== undefined');
  });

  test('rejects the agent BEFORE the secret is written', () => {
    const guard = src.indexOf(GUARD_MESSAGE);
    const write = src.indexOf('.insert(projectSecrets)');
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
  });

  test('is conditional — a plain runtime/default secret is still allowed', () => {
    // The guard is NOT an unconditional `if (getAgentGrant(c)) return 403`: it
    // ANDs the agent check with the delivery-policy inputs, so an agent may
    // still create a plain runtime/default secret (matching product behavior).
    expect(src).toContain('getAgentGrant(c) &&');
  });
});

describe('DELETE /:projectId/secrets/:name', () => {
  const src = handlerSource('delete', '/{projectId}/secrets/{name}');

  test('refuses an agent session deleting a policy-bearing secret', () => {
    expect(src).toContain('getAgentGrant(c)');
    expect(src).toContain(GUARD_MESSAGE);
    // Conditional on the target carrying a non-runtime delivery policy.
    expect(src).toContain("existing.strategy !== 'runtime'");
  });

  test('rejects the agent BEFORE the row is deleted', () => {
    const guard = src.indexOf(GUARD_MESSAGE);
    const del = src.indexOf('runAuditedTransaction');
    expect(guard).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(del);
  });
});

describe('POST /:projectId/secrets/sync', () => {
  const src = handlerSource('post', '/{projectId}/secrets/sync');

  test('refuses an agent session outright', () => {
    expect(src).toContain('getAgentGrant(c)');
    expect(src).toContain(GUARD_MESSAGE);
    expect(src).toContain('403');
  });

  test('rejects the agent BEFORE the re-mint propagation runs', () => {
    const guard = src.indexOf(GUARD_MESSAGE);
    const propagate = src.indexOf('propagateProjectSecretsToActiveSandboxes(projectId)');
    expect(guard).toBeGreaterThan(-1);
    expect(propagate).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(propagate);
  });
});
