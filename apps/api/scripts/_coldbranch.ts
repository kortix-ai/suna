import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';
const PTKEY = readFileSync('/tmp/ptkey', 'utf8').trim();
const tok = (await createAccountToken({ accountId: 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71', userId: 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71', name: 'coldbranch' })).secretKey;
const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const prov: any = await (await fetch('http://localhost:8008/v1/projects/provision', { method: 'POST', headers: H, body: JSON.stringify({ name: `coldbranch-${Date.now()}`, seed_starter: true }) })).json();
const ses: any = await (await fetch(`http://localhost:8008/v1/projects/${prov.project_id}/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ branch_already_created: false }) })).json();
console.log('session=' + ses.session_id);
let row: any = null;
for (let i = 0; i < 60 && !row?.externalId; i++) { [row] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, ses.session_id)).limit(1); if (!row?.externalId) await Bun.sleep(500); }
const exec = async (c: string) => { const r: any = await (await fetch(`https://api.platinum.dev/v1/sandboxes/${row.externalId}/exec`, { method: 'POST', headers: { Authorization: `Bearer ${PTKEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: ['sh','-lc',c] }), signal: AbortSignal.timeout(20000) })).json(); return (r.result?.stdout ?? '').trim(); };
// wait runtimeReady via row.baseUrl
const base = row.baseUrl;
for (let i = 0; i < 200; i++) { try { const j: any = await (await fetch(`${base}/kortix/health`, { headers: H, signal: AbortSignal.timeout(3000) })).json(); if (j.runtimeReady) break; } catch {} await Bun.sleep(300); }
console.log('at-ready: ' + await exec('cd /workspace && git branch --show-current'));
await Bun.sleep(3000);
console.log('at+3s:    ' + await exec('cd /workspace && git branch --show-current'));
await fetch(`https://api.platinum.dev/v1/sandboxes/${row.externalId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${PTKEY}` } });
console.log('cleaned');
process.exit(0);
