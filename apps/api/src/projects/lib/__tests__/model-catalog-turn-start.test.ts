/**
 * Self-heal on an UNKNOWN MODEL, at turn start — see the module doc on
 * `../model-catalog-turn-start.ts` for the full design. These tests exercise
 * the pure core (`convergeModelCatalogBeforeTurnStart`, injected deps — no
 * DB, no network) and the daemon-call helper (`convergeSandboxModelCatalog`,
 * injected deps too).
 *
 * Fixture note: the exact scenario a real dev box reproduced 2026-09-26 — a
 * box woken/restarted still serving the 2026-08-10 managed lineup
 * (`deepseek-v4-flash`, `glm-5.2`, …) against a control plane that now serves
 * `deepseek-v4.1-flash` / `glm-5.3-flash` / `kimi-k3` — is threaded through
 * as the running example.
 */
import { describe, expect, test } from 'bun:test';
import {
  convergeModelCatalogBeforeTurnStart,
  convergeSandboxModelCatalog,
  modelCatalogRepairIncomplete,
  type ModelCatalogConvergeDeps,
  type ModelCatalogTurnStartDeps,
} from '../model-catalog-turn-start';

const CURRENT_MANAGED_IDS = new Set(['deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k3']);
const isManagedModelId = (id: string) => CURRENT_MANAGED_IDS.has(id);

function deps(over: Partial<ModelCatalogTurnStartDeps> = {}): ModelCatalogTurnStartDeps {
  return {
    isManagedModelId,
    lastKnown: () => undefined,
    probe: async () => undefined,
    convergeCatalog: async () => null,
    ...over,
  };
}

describe('convergeModelCatalogBeforeTurnStart', () => {
  test('skips instantly for no model — zero calls', async () => {
    let probed = false;
    const result = await convergeModelCatalogBeforeTurnStart(
      'sess-1',
      null,
      deps({ probe: async () => { probed = true; return undefined; } }),
    );
    expect(result).toEqual({ decision: 'skipped' });
    expect(probed).toBe(false);
  });

  test('skips instantly for a non-managed (BYOK) model id — zero calls', async () => {
    let probed = false;
    let converged = false;
    const result = await convergeModelCatalogBeforeTurnStart(
      'sess-1',
      'claude-sonnet-4-6',
      deps({
        probe: async () => { probed = true; return undefined; },
        convergeCatalog: async () => { converged = true; return null; },
      }),
    );
    expect(result).toEqual({ decision: 'skipped' });
    expect(probed).toBe(false);
    expect(converged).toBe(false);
  });

  test('a warm memo that already has the model is current — no probe, no converge', async () => {
    let probed = false;
    let converged = false;
    const result = await convergeModelCatalogBeforeTurnStart(
      'sess-1',
      'deepseek-v4.1-flash',
      deps({
        lastKnown: () => ({ ids: ['deepseek-v4.1-flash', 'glm-5.3-flash'], fallbackReason: null }),
        probe: async () => { probed = true; return undefined; },
        convergeCatalog: async () => { converged = true; return null; },
      }),
    );
    expect(result).toEqual({ decision: 'current' });
    expect(probed).toBe(false);
    expect(converged).toBe(false);
  });

  test('a cold memo probes once, and a confirmed-present answer is current', async () => {
    let probeCalls = 0;
    const result = await convergeModelCatalogBeforeTurnStart(
      'sess-1',
      'kimi-k3',
      deps({
        lastKnown: () => undefined,
        probe: async () => {
          probeCalls++;
          return { ids: ['kimi-k3'], fallbackReason: null };
        },
      }),
    );
    expect(result).toEqual({ decision: 'current' });
    expect(probeCalls).toBe(1);
  });

  // THE 2026-09-26 fixture. The box's map is the STALE lineup; the memo is
  // either cold or explicitly unconfirmed (`ids: null`) — either way, the
  // requested current id is not in it, so the daemon converge call fires.
  test('an unconfirmed catalog (ids: null) repairs eagerly, even with no probe needed', async () => {
    let convergeCalls = 0;
    const result = await convergeModelCatalogBeforeTurnStart(
      'sess-1',
      'deepseek-v4.1-flash',
      deps({
        lastKnown: () => ({ ids: null, fallbackReason: 'boot fetch failed' }),
        convergeCatalog: async () => {
          convergeCalls++;
          return { outcome: 'restarted' };
        },
      }),
    );
    expect(result).toEqual({ decision: 'converged', daemonOutcome: 'restarted' });
    expect(convergeCalls).toBe(1);
  });

  test('a confirmed-stale map (the model is missing from known ids) repairs eagerly', async () => {
    const result = await convergeModelCatalogBeforeTurnStart(
      'sess-1',
      'deepseek-v4.1-flash',
      deps({
        lastKnown: () => ({
          ids: ['deepseek-v4-flash', 'glm-5.2', 'grok-4.6'], // the OLD lineup
          fallbackReason: null,
        }),
        convergeCatalog: async () => ({ outcome: 'restarted' }),
      }),
    );
    expect(result).toEqual({ decision: 'converged', daemonOutcome: 'restarted' });
  });

  test('the daemon call reporting unchanged/file-updated still reads as converged, not current', async () => {
    for (const outcome of ['unchanged', 'file-updated'] as const) {
      const result = await convergeModelCatalogBeforeTurnStart(
        'sess-1',
        'deepseek-v4.1-flash',
        deps({
          lastKnown: () => ({ ids: null, fallbackReason: null }),
          convergeCatalog: async () => ({ outcome }),
        }),
      );
      expect(result).toEqual({ decision: 'converged', daemonOutcome: outcome });
    }
  });

  test('an unreachable box after a cold probe is unknown — never refuses by itself', async () => {
    const result = await convergeModelCatalogBeforeTurnStart(
      'sess-1',
      'deepseek-v4.1-flash',
      deps({
        lastKnown: () => undefined,
        probe: async () => undefined,
        convergeCatalog: async () => null,
      }),
    );
    expect(result).toEqual({ decision: 'unknown' });
  });

  test('a throwing dep never escapes — the turn is never blocked by this lane failing', async () => {
    const result = await convergeModelCatalogBeforeTurnStart(
      'sess-1',
      'deepseek-v4.1-flash',
      deps({
        lastKnown: () => {
          throw new Error('memo exploded');
        },
      }),
    );
    expect(result).toEqual({ decision: 'unknown' });
  });
});

describe('modelCatalogRepairIncomplete', () => {
  test('restarted / unchanged / file-updated are NOT incomplete — forward the turn normally', () => {
    expect(modelCatalogRepairIncomplete({ decision: 'converged', daemonOutcome: 'restarted' })).toBe(
      false,
    );
    expect(modelCatalogRepairIncomplete({ decision: 'converged', daemonOutcome: 'unchanged' })).toBe(
      false,
    );
    expect(
      modelCatalogRepairIncomplete({ decision: 'converged', daemonOutcome: 'file-updated' }),
    ).toBe(false);
  });

  test('declined / no-gateway ARE incomplete — the running process still lacks the model', () => {
    expect(modelCatalogRepairIncomplete({ decision: 'converged', daemonOutcome: 'declined' })).toBe(
      true,
    );
    expect(
      modelCatalogRepairIncomplete({ decision: 'converged', daemonOutcome: 'no-gateway' }),
    ).toBe(true);
  });

  test('skipped / current / unknown are never incomplete', () => {
    expect(modelCatalogRepairIncomplete({ decision: 'skipped' })).toBe(false);
    expect(modelCatalogRepairIncomplete({ decision: 'current' })).toBe(false);
    expect(modelCatalogRepairIncomplete({ decision: 'unknown' })).toBe(false);
  });
});

describe('convergeSandboxModelCatalog', () => {
  function daemonDeps(over: Partial<ModelCatalogConvergeDeps> = {}): ModelCatalogConvergeDeps {
    return {
      loadActiveSandbox: async () => ({ externalId: 'ext-1', serviceKey: 'svc-key' }),
      resolveIngress: async () => ({ url: 'https://box.test', headers: {} }),
      fetch: async () => new Response(JSON.stringify({ outcome: 'restarted', missing: ['deepseek-v4.1-flash'] }), { status: 200 }),
      ...over,
    };
  }

  test('POSTs /kortix/catalog/converge with the sandbox service key and parses the result', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const result = await convergeSandboxModelCatalog(
      'sess-1',
      daemonDeps({
        fetch: async (url, init) => {
          calls.push({ url: String(url), init });
          return new Response(JSON.stringify({ outcome: 'restarted', missing: ['x'] }), { status: 200 });
        },
      }),
    );
    expect(result).toEqual({ outcome: 'restarted', missing: ['x'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://box.test/kortix/catalog/converge');
    expect(calls[0]!.init?.method).toBe('POST');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer svc-key');
  });

  test('no active sandbox for this session — null, no fetch attempted', async () => {
    let fetched = false;
    const result = await convergeSandboxModelCatalog(
      'sess-1',
      daemonDeps({
        loadActiveSandbox: async () => null,
        fetch: async () => { fetched = true; return new Response('{}'); },
      }),
    );
    expect(result).toBeNull();
    expect(fetched).toBe(false);
  });

  test('a non-2xx response is null, not a thrown error', async () => {
    const result = await convergeSandboxModelCatalog(
      'sess-1',
      daemonDeps({ fetch: async () => new Response('nope', { status: 500 }) }),
    );
    expect(result).toBeNull();
  });

  test('an unreachable box (fetch rejects) is null, never an uncaught rejection', async () => {
    const result = await convergeSandboxModelCatalog(
      'sess-1',
      daemonDeps({
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );
    expect(result).toBeNull();
  });

  test('a malformed response body is null, never a thrown parse error', async () => {
    const result = await convergeSandboxModelCatalog(
      'sess-1',
      daemonDeps({ fetch: async () => new Response('not json', { status: 200 }) }),
    );
    expect(result).toBeNull();
  });
});
