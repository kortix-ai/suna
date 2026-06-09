/**
 * Manually bake + verify a warm (memory-state) snapshot via the repo module.
 *
 *   cd apps/api && \
 *     KORTIX_WARM_SNAPSHOT_ENABLED=true \
 *     DAYTONA_API_KEY=dtn_... \
 *     DAYTONA_WARM_TARGET=experimental \
 *     bun run scripts/bake-warm-snapshot.ts
 *
 * Env knobs:
 *   WARM_SNAPSHOT_NAME   target name (default: kortix-warm-manual-<rand>)
 *   VERIFY=1             after baking, boot a sandbox from it and time how fast
 *                        opencode answers (default on)
 *   KEEP_SNAPSHOT=1      don't delete the baked snapshot at the end
 */
import { getDaytonaWarm, warmSnapshotsEnabled } from '../src/shared/daytona';
import { bakeWarmSnapshot } from '../src/snapshots/warm-bake';

async function main() {
  if (!warmSnapshotsEnabled()) {
    console.error(
      'Warm snapshots not enabled. Set KORTIX_WARM_SNAPSHOT_ENABLED=true, DAYTONA_API_KEY, DAYTONA_WARM_TARGET.',
    );
    process.exit(1);
  }
  const name = process.env.WARM_SNAPSHOT_NAME || `kortix-warm-manual-${Math.random().toString(36).slice(2, 8)}`;
  const verify = process.env.VERIFY !== '0';
  const keep = process.env.KEEP_SNAPSHOT === '1';
  const daytona = getDaytonaWarm();

  console.log(`\n=== baking warm snapshot "${name}" ===`);
  const res = await bakeWarmSnapshot({ name, onLog: (l) => console.log(l) });
  console.log(
    `\nbaked ${res.snapshotName} from ${res.baseSnapshot} ` +
      `(bake ${(res.bakeMs / 1000).toFixed(1)}s + snapshot ${(res.snapshotMs / 1000).toFixed(1)}s)`,
  );

  if (verify) {
    console.log('\n=== verifying warm boot (runtime installed) ===');
    const t = Date.now();
    const sb = await daytona.create({ snapshot: name }, { timeout: 120 });
    const createS = ((Date.now() - t) / 1000).toFixed(1);
    const probe = await sb.process.executeCommand(
      `echo "create=${createS}s"; ` +
        `for b in kortix-agent kortix opencode bun agent-browser node; do printf '%-14s ' "$b"; command -v "$b" || echo MISSING; done; ` +
        `echo "opencode_db=$(ls /opt/kortix/home/.local/share/opencode 2>/dev/null | head -1 || echo none)"; ` +
        `kortix --version 2>&1 | head -1`,
      undefined,
      undefined,
      60,
    );
    const out = (probe.result || '').trim();
    console.log(out);
    const ok = !out.includes('MISSING');
    console.log(ok ? `RESULT: full runtime present on warm boot (create ${createS}s) ✅` : 'RESULT: runtime incomplete ❌');
    await sb.delete().catch(() => {});
  }

  if (!keep) {
    try {
      const s = await daytona.snapshot.get(name);
      await daytona.snapshot.delete(s);
      console.log(`\ncleaned up snapshot ${name}`);
    } catch {
      /* ignore */
    }
  } else {
    console.log(`\nkept snapshot ${name} (KEEP_SNAPSHOT=1)`);
  }
}

main().catch((err) => {
  console.error('\nbake-warm-snapshot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
