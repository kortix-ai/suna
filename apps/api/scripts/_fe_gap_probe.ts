// Reproduce the FE's exact polling path with timestamps: when does the row
// actually flip active, and how slow is each poll?
import { createAccountToken } from '../src/repositories/account-tokens';
const ACC = 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'gap' })).secretKey;
const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const B = 'http://localhost:8008';
const now = () => Date.now();
const prov: any = await (await fetch(`${B}/v1/projects/provision`, { method: 'POST', headers: H, body: JSON.stringify({ name: `gap-${now()}`, seed_starter: true }) })).json();
const t0 = now();
const ses: any = await (await fetch(`${B}/v1/projects/${prov.project_id}/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ branch_already_created: false }) })).json();
console.log(`create POST +${now() - t0}ms`);
// poll exactly like the FE: GET .../sandbox every 300ms
let active = 0;
while (!active && now() - t0 < 30000) {
  const ts = now();
  const r: any = await (await fetch(`${B}/v1/projects/${prov.project_id}/sessions/${ses.session_id}/sandbox`, { headers: H })).json().catch(() => null);
  const dur = now() - ts;
  if (r?.status === 'active') { active = now() - t0; console.log(`row ACTIVE at +${active}ms (this poll took ${dur}ms)`); break; }
  if (dur > 500) console.log(`slow poll: ${dur}ms status=${r?.status}`);
  await Bun.sleep(300);
}
console.log(`VERDICT: backend-visible active at +${active}ms — anything beyond this in the FE is frontend-side.`);
process.exit(0);
