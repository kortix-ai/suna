import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_SRC = resolve(import.meta.dir, '../..');
const GENERIC_DATA_PATHS = [
  'sandbox-proxy/backend.ts',
  'sandbox-proxy/routes/preview.ts',
  // The forwarder `routes/preview.ts` re-exports (R4.2).
  'sandbox-proxy/forward/access.ts',
  'sandbox-proxy/forward/forward-to-sandbox.ts',
  'sandbox-proxy/forward/retry.ts',
  'sandbox-proxy/forward/turn-start.ts',
  'sandbox-proxy/forward/upstream.ts',
  'sandbox-proxy/forward/wake.ts',
  'sandbox-proxy/forward/ws-upstream.ts',
  'sandbox-proxy/routes/public-share.ts',
  'projects/lib/sandbox-daemon-ready.ts',
  // The env-sync implementation is split across sibling modules (KRTX-300);
  // `sandbox-env-sync.ts` itself is the re-export entry.
  'projects/lib/sandbox-env-snapshot.ts',
  'projects/lib/sandbox-env-push.ts',
  'projects/lib/sandbox-secret-propagation.ts',
  'projects/lib/sandbox-session-push.ts',
  'projects/opencode-mapping.ts',
  'projects/session-open/session-open.ts',
  'projects/session-open/session-open-provision.ts',
  'projects/session-open/session-open-readiness.ts',
  'projects/session-open/session-open-recovery.ts',
  'projects/session-open/session-open-guarantee.ts',
  'projects/session-open/resume-stopped-sandbox.ts',
  'projects/session-open/stopped-wake-result.ts',
  // Egress-enforced delivery. There is ONE mechanism for every provider
  // and no verdict to
  // read: the guest holds a handle and the broker route substitutes the value.
  // A name comparison anywhere in here reintroduces the split that used to make
  // a provider silently lose a feature it already had for free.
  'projects/secrets.ts',
  'projects/secret-capabilities.ts',
  'secrets/network-boundary.ts',
  'secrets/http-broker.ts',
];

describe('sandbox provider architecture boundary', () => {
  test('concrete providers use the registry helpers without changing their public behavior', async () => {
    const registry = await import('./index');
    const opts = { accountId: 'a', userId: 'u', name: 'box' };
    for (const name of ['daytona', 'e2b', 'platinum'] as const) {
      const provider = await import(`./${name}.ts`);
      expect(provider).toBeDefined();
      expect(registry.sandboxWorkloadType(opts)).toBe('session');
      expect(registry.sandboxWorkloadType({ ...opts, workloadType: 'app' })).toBe('app');
      expect(() => registry.assertWorkloadCredential(name, opts, {})).toThrow(
        `[${name}] create() called without KORTIX_TOKEN for session workload`,
      );
      expect(() =>
        registry.assertWorkloadCredential(
          name,
          { ...opts, workloadType: 'app' },
          { KORTIX_APPD_TOKEN: 'synthetic' },
        ),
      ).not.toThrow();
    }
    expect(new registry.SandboxTemplateNotFoundError('missing').name).toBe(
      'SandboxTemplateNotFoundError',
    );
    expect(new registry.WarmRuntimeUnavailableError('missing').name).toBe(
      'WarmRuntimeUnavailableError',
    );
  });

  test('concrete providers have no runtime import of the registry', () => {
    for (const name of ['daytona', 'e2b', 'platinum']) {
      const source = readFileSync(resolve(import.meta.dir, `${name}.ts`), 'utf8');
      expect(source, name).not.toMatch(
        /(?:import|export)\s*(?:type\s*)?(?:\{[^}]*\}|\*\s+from)\s*['"]\.\/index['"]/s,
      );
    }
  });

  test('proxy and runtime data paths contain no provider-specific branching or traffic headers', () => {
    for (const relativePath of GENERIC_DATA_PATHS) {
      const source = readFileSync(resolve(API_SRC, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(
        /(?:provider|providerName)\s*(?:===|!==|==|!=)\s*['"](?:daytona|platinum|e2b)['"]/i,
      );
      expect(source, relativePath).not.toMatch(
        /x-daytona-|x-access-token|e2b-traffic-access-token/i,
      );
    }
  });
});
