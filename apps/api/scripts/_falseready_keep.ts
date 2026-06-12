import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'frc' })).secretKey;
const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const B = 'http://localhost:8008';
const now = () => Date.now();

const prov: any = await (await fetch(`${B}/v1/projects/provision`, { method: 'POST', headers: H, body: JSON.stringify({ name: `frc-${now()}`, seed_starter: true }) })).json();
const t0 = now();
const ses: any = await (await fetch(`${B}/v1/projects/${prov.project_id}/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ branch_already_created: false }) })).json();
console.log('session', ses.session_id?.slice(0, 8));
let row: any = null;
while (!row?.externalId) { [row] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, ses.session_id)).limit(1); if (!row?.externalId) await Bun.sleep(200); }
const base = (row as any).baseUrl;
console.log(`sandbox-active +${now() - t0}ms ext=${row.externalId}`);
let falsePositives = 0, readyAt = 0, samples = 0;
while (now() - t0 < 120_000) {
  try {
    const j: any = await (await fetch(`${base}/kortix/health`, { headers: H, signal: AbortSignal.timeout(2500) })).json();
    samples++;
    if (j.runtimeReady === true) {
      if (j.branch === ses.session_id) { readyAt = now() - t0; break; }
      falsePositives++;
      console.log(`FALSE READY at +${now() - t0}ms branch=${j.branch}`);
    }
  } catch {}
  await Bun.sleep(200);
}
console.log(`READY(honest) +${readyAt}ms falsePositives=${falsePositives} samples=${samples}`);
console.log(falsePositives === 0 && readyAt > 0 ? 'PASS' : 'FAIL');
// cleanup
const { readFileSync } = await import('fs');

process.exit(0);
