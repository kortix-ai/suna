/**
 * Lifecycle verification for the Platinum provider:
 *
 *   create → ensureRunning (no-op) → resolveEndpoint (URL₁)
 *         → stop → getStatus=stopped
 *         → start → getStatus=running → resolveEndpoint (URL₂, may differ)
 *         → ensureRunning (no-op while running)
 *         → stop (idempotent path) → ensureRunning (auto-resume) → running
 *         → remove
 *
 * Asserts every transition + that resolveEndpoint always returns a usable URL.
 */

import { getProvider } from '../src/platform/providers';

async function expect<T>(label: string, fn: () => Promise<T>, check: (v: T) => boolean | string): Promise<T> {
  const v = await fn();
  const r = check(v);
  if (r === true) { console.log(`✓ ${label} → ${typeof v === 'string' ? v : JSON.stringify(v).slice(0, 80)}`); return v; }
  const msg = typeof r === 'string' ? r : `unexpected: ${JSON.stringify(v).slice(0, 200)}`;
  throw new Error(`FAIL [${label}]: ${msg}`);
}

async function main() {
  const p = getProvider('platinum');
  const accountId = 'lifecycle-acct';
  const userId    = 'lifecycle-user';

  // Force pt-base for this test. kortix-base (and any future Platinum
  // template that overrides entrypoint to a user process) doesn't survive
  // stop/start cleanly — Platinum's "wait for running after start" check
  // assumes the default init/invm-agent is PID 1. The provider's stop/start
  // contract is what we're verifying; pt-base is the right substrate.
  console.log('→ create (forcing pt-base via opts.snapshot)');
  const created = await p.create({ accountId, userId, name: 'lifecycle', snapshot: 'pt-base', envVars: { KORTIX_TOKEN: 'svc-key-1' } });
  console.log(`  externalId=${created.externalId}`);
  const id = created.externalId;

  try {
    await expect('getStatus after create', () => p.getStatus(id), (s) => s === 'running' || `got ${s}`);
    await expect('ensureRunning (no-op)', async () => { await p.ensureRunning(id); return 'ok'; }, () => true);
    const url1 = await expect('resolveEndpoint URL₁', () => p.resolveEndpoint(id), (e) => e.url.startsWith('http') || 'no url');

    // Give Platinum a beat to settle after the expose call before pausing.
    await new Promise((r) => setTimeout(r, 500));

    console.log('→ stop');
    await p.stop(id);
    // Platinum transitions stopping → stopped; poll a few times.
    await expect('getStatus after stop', async () => {
      for (let i = 0; i < 20; i++) {
        const s = await p.getStatus(id);
        if (s === 'stopped') return s;
        await new Promise((r) => setTimeout(r, 500));
      }
      return await p.getStatus(id);
    }, (s) => s === 'stopped' || `got ${s}`);

    console.log('→ start');
    await p.start(id);
    await expect('getStatus after start', async () => {
      for (let i = 0; i < 20; i++) {
        const s = await p.getStatus(id);
        if (s === 'running') return s;
        await new Promise((r) => setTimeout(r, 500));
      }
      return await p.getStatus(id);
    }, (s) => s === 'running' || `got ${s}`);

    const url2 = await expect('resolveEndpoint URL₂', () => p.resolveEndpoint(id), (e) => e.url.startsWith('http') || 'no url');
    // Hostname schema should be stable; the HMAC token can rotate on re-expose.
    const h1 = new URL(url1.url).hostname;
    const h2 = new URL(url2.url).hostname;
    if (h1 !== h2) throw new Error(`hostname drifted after start: ${h1} vs ${h2}`);
    console.log(`✓ hostname stable across stop/start: ${h1}`);

    console.log('→ stop again');
    await p.stop(id);
    // wait for stopped before ensureRunning, so we exercise the auto-resume path
    for (let i = 0; i < 20; i++) {
      const s = await p.getStatus(id);
      if (s === 'stopped') break;
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log('→ ensureRunning (should auto-resume)');
    await p.ensureRunning(id);
    await expect('getStatus after ensureRunning', () => p.getStatus(id), (s) => s === 'running' || `got ${s}`);

    console.log('\nPLATINUM LIFECYCLE: PASS');
  } finally {
    console.log('→ remove');
    await p.remove(id).catch((e) => console.error(`! remove failed: ${e}`));
  }
}

main().catch((e) => { console.error('PLATINUM LIFECYCLE: FAIL'); console.error(e); process.exit(1); });
