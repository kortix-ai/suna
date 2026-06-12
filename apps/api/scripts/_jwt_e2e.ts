// Exact UI flow with the user's real browser JWT.
import { readFileSync } from 'fs';
const JWT = readFileSync('/tmp/userjwt', 'utf8').trim();
const H = { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' };
const BASE = 'http://localhost:8008';
const PID = '40dad27b-0e7b-489e-bc2c-97527ee9597c';
const now = () => Date.now();

const t0 = now();
const ses: any = await (await fetch(`${BASE}/v1/projects/${PID}/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ branch_already_created: false }) })).json();
if (!ses.session_id) { console.log('FAILED:', JSON.stringify(ses).slice(0, 200)); process.exit(1); }
console.log(`session-created +${now() - t0}ms (${ses.session_id})`);

// poll sandbox row like the FE (300ms)
let sbx: any = null;
while (!sbx?.external_id || sbx?.status === 'provisioning') {
  sbx = await (await fetch(`${BASE}/v1/projects/${PID}/sessions/${ses.session_id}/sandbox`, { headers: H })).json().catch(() => null);
  if (sbx?.status === 'active') break;
  await Bun.sleep(150);
}
console.log(`sandbox-active +${now() - t0}ms (${sbx.external_id})`);

// poll health through the same proxy the FE uses
const base = `${BASE}/v1/p/${sbx.external_id}/8000`;
while (true) {
  try { const j: any = await (await fetch(`${base}/kortix/health`, { headers: H, signal: AbortSignal.timeout(3000) })).json(); if (j.runtimeReady) break; } catch {}
  await Bun.sleep(150);
}
console.log(`runtime-ready +${now() - t0}ms`);

// chat-ready equivalent
const e: any = await (await fetch(`${BASE}/v1/projects/${PID}/sessions/${ses.session_id}/ensure-opencode`, { method: 'POST', headers: H, body: '{}' })).json();
console.log(`ensure +${now() - t0}ms (${e?.ensure?.reason ?? '?'}) pin=${(e?.opencode_session_id ?? '').slice(0, 12)}`);
console.log(`USABLE in ${now() - t0}ms`);
process.exit(0);
