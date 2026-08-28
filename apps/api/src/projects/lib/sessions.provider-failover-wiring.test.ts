import { describe, expect, test } from 'bun:test';

// Source tripwire for the 2026-08-26 Platinum incident.
//
// `platform_settings.provider_fallback` was ON in production, yet 654 sessions
// died against a provider at capacity and `session_sandboxes` recorded ZERO
// handoffs. The unit rules were all correct in isolation — the WIRING was the
// defect: createProjectSession resolved the weighted balancer's pick and handed
// it to provisionSessionSandbox as `provider`, which read any provider as
// "explicitly selected". That made the failover branch unreachable for every
// project session, and no unit test could see it.
//
// These assertions fail the moment the two ends stop agreeing.

const read = (rel: string): Promise<string> =>
  Bun.file(new URL(rel, import.meta.url)).text();

describe('provider failover wiring', () => {
  test('createProjectSession marks a balancer pick as UNLOCKED and forwards it', async () => {
    const source = await read('./sessions.ts');
    const locked = source.indexOf('const providerLocked = sessionProviderIsLocked(picked)');
    const provision = source.indexOf('provisionSessionSandbox({', locked);
    expect(locked).toBeGreaterThan(-1);
    expect(provision).toBeGreaterThan(locked);
    // The flag must actually reach the provisioner, not just be computed.
    expect(source.slice(provision)).toContain('providerLocked,');
  });

  test('the provisioner honors providerLocked instead of "any provider is explicit"', async () => {
    const source = await read('../../platform/services/session-sandbox.ts');
    expect(source).toContain(
      'const providerWasExplicitlySelected = opts.providerLocked ?? opts.provider !== undefined;',
    );
    // The old form is exactly what made failover dead code. Never reintroduce it.
    expect(source).not.toContain(
      'const providerWasExplicitlySelected = opts.provider !== undefined;',
    );
  });

  test('the failover branch resolves its target through the pure, tested rule', async () => {
    const source = await read('../../platform/services/session-sandbox.ts');
    const helper = source.indexOf('nextFailoverProvider({');
    const failover = source.indexOf('failoverAttempted', helper);
    expect(helper).toBeGreaterThan(-1);
    expect(source.slice(helper, helper + 400)).toContain('providerLocked: providerWasExplicitlySelected');
    expect(source.slice(helper, helper + 400)).toContain('fallbackEnabled: providerFallbackSetting().enabled');
    expect(failover).toBe(-1); // guard against a stray rename leaving two paths
  });
});
