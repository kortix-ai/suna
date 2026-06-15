// FULL UI-path e2e with health-JSON capture: which gate lies, and when.
import { readFileSync } from 'fs';
const SRK = process.env.SRK!; const ANON = process.env.ANON!;
const now = () => Date.now();
// mint a real user session (same account as the browser)
const ht = (await (await fetch('http://127.0.0.1:54321/auth/v1/admin/generate_link', { method: 'POST', headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', email: 'vukasinkubet@gmail.com' }) })).json() as any).hashed_token;
const sess: any = await (await fetch('http://127.0.0.1:54321/auth/v1/verify', { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: ht }) })).json();
const H = { Authorization: `Bearer ${sess.access_token}`, 'Content-Type': 'application/json' };
const B = 'http://localhost:8008';

const prov: any = await (await fetch(`${B}/v1/projects/provision`, { method: 'POST', headers: H, body: JSON.stringify({ name: `deepe2e-${now()}`, seed_starter: true }) })).json();
console.log('project', prov.project_id?.slice(0, 8));
const t0 = now();
const ses: any = await (await fetch(`${B}/v1/projects/${prov.project_id}/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ branch_already_created: false }) })).json();
// sandbox poll
let sbx: any = null;
while (!sbx?.external_id) { sbx = await (await fetch(`${B}/v1/projects/${prov.project_id}/sessions/${ses.session_id}/sandbox`, { headers: H })).json().catch(() => null); if (!sbx?.external_id) await Bun.sleep(200); }
console.log(`sandbox-active +${now() - t0}ms ${sbx.external_id}`);
// health via the comp proxy (same daemon endpoint the FE reads), capture EVERY distinct state
const base = `${B}/v1/p/${sbx.external_id}/8000`;
let last = '';
let readyAt = 0; let lie = false;
while (now() - t0 < 120000) {
  try {
    const j: any = await (await fetch(`${base}/kortix/health`, { headers: H, signal: AbortSignal.timeout(3000) })).json();
    const sig = JSON.stringify({ r: j.runtimeReady, rq: j.repo_required, rr: j.repo_ready, br: j.branch, oc: j.opencode });
    if (sig !== last) { console.log(`+${now() - t0}ms`, sig); last = sig; }
    if (j.runtimeReady === true) {
      if (j.branch !== ses.session_id) { lie = true; console.log(`*** LIE: ready=true with branch=${j.branch} repo_required=${j.repo_required}`); }
      readyAt = now() - t0; break;
    }
  } catch {}
  await Bun.sleep(250);
}
console.log(`ready +${readyAt}ms lie=${lie}`);
console.log('SBX=' + sbx.external_id);
process.exit(0);
