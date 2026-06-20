// Retest the kortix flow from the kortix API after the 3 fixes (S3 CAS GC,
// zstd CAS, opencode idle-poll). Drives the EXACT product path: POST /sessions
// (provider=platinum) → warm restore_clone of the fixed kortix-default template
// → poll runtimeReady → measure opencode idle CPU (the fix: ~2% not ~55%).
import { createAccountToken } from '../src/repositories/account-tokens';
import { db } from '../src/shared/db';
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';

const ACC = process.env.ACC ?? 'fbea71d0-9655-4ab4-aca5-1b68e1ae7f71';
const PROJECT = process.env.PROJECT ?? 'f45dc8e0-3382-4ca9-8f73-78f43dfd301b';
const BASE = 'http://localhost:8008';
const PT = 'https://api.platinum.dev';
const PTKEY = readFileSync('/tmp/ptkey', 'utf8').trim();
const N = Number(process.env.N ?? 4);
const tok = (await createAccountToken({ accountId: ACC, userId: ACC, name: 'retest-fix' })).secretKey;
const H: Record<string, string> = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const PTH: Record<string, string> = { Authorization: `Bearer ${PTKEY}`, 'Content-Type': 'application/json' };
const now = () => Date.now();

async function ptExec(ext: string, cmd: string): Promise<string> {
  try {
    const r = await fetch(`${PT}/v1/sandboxes/${ext}/exec`, {
      method: 'POST', headers: PTH,
      body: JSON.stringify({ cmd: ['sh', '-lc', cmd] }), signal: AbortSignal.timeout(40000),
    });
    const j: any = await r.json().catch(() => ({}));
    return (j.result?.stdout ?? '') + (j.result?.stderr ?? '') + (j.error ?? '');
  } catch (e: any) { return 'EXECERR:' + String(e?.message ?? e).slice(0, 80); }
}
async function guestReady(ext: string): Promise<{ ready: boolean; body: string }> {
  const out = await ptExec(ext, 'curl -s -m3 http://127.0.0.1:8000/kortix/health');
  let p: any = {}; try { p = JSON.parse(out); } catch {}
  return { ready: p?.runtimeReady === true, body: out.slice(0, 120) };
}

const created: string[] = [];
const runs: number[] = [];
for (let n = 1; n <= N; n++) {
  const t0 = now();
  const ses: any = await (await fetch(`${BASE}/v1/projects/${PROJECT}/sessions`, {
    method: 'POST', headers: H, body: JSON.stringify({ provider: 'platinum', branch_already_created: false }),
  })).json();
  if (!ses.session_id) { console.log(`[#${n}] session FAIL ${JSON.stringify(ses).slice(0, 200)}`); continue; }
  let ext = '';
  for (let i = 0; i < 150; i++) {
    const [r] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, ses.session_id)).limit(1);
    if ((r as any)?.externalId) { ext = (r as any).externalId; break; }
    await Bun.sleep(200);
  }
  if (!ext) { console.log(`[#${n}] no externalId after 30s`); continue; }
  created.push(ext);
  let readyMs = -1, last = '';
  const end = now() + 120000;
  while (now() < end) { const g = await guestReady(ext); last = g.body; if (g.ready) { readyMs = now() - t0; break; } await Bun.sleep(700); }
  runs.push(readyMs);
  let info = '';
  if (n === 1) {
    const sj: any = await (await fetch(`${PT}/v1/sandboxes/${ext}`, { headers: PTH })).json().catch(() => ({}));
    info = `tpl=${sj.templateName ?? sj.template ?? '?'} restoredFrom=${sj.restoredFrom ?? sj.via ?? sj.createMode ?? '?'} host=${(sj.hostId ?? sj.host ?? '?')}`;
  }
  console.log(`[#${n}] create→runtimeReady = ${readyMs < 0 ? 'TIMEOUT ' + last : (readyMs / 1000).toFixed(2) + 's'}  ${ext} ${info}`);
}

// ── opencode idle CPU (the fix): sample utime+stime over 5s → cores ───────────
const probe = created.find((_, i) => runs[i] > 0) ?? created[0];
if (probe) {
  console.log(`\n[cpu] measuring opencode + daemon idle CPU on ${probe} (FIX expects opencode ~0.02-0.05 cores, was ~0.55)…`);
  const m = await ptExec(probe, [
    `g(){ awk '{print $14+$15}' /proc/$1/stat 2>/dev/null; }`,
    `oc=$(pgrep -f opencode | head -1); ka=$(pgrep -fl kortix-agent | grep -v pgrep | awk '{print $1}' | head -1)`,
    `o0=$(g $oc); k0=$(g $ka); sleep 5; o1=$(g $oc); k1=$(g $ka)`,
    `awk -v o0="$o0" -v o1="$o1" -v k0="$k0" -v k1="$k1" 'BEGIN{printf "opencode_cores=%.3f daemon_cores=%.3f (5s sample, HZ=100)\\n",(o1-o0)/500.0,(k1-k0)/500.0}'`,
  ].join('\n'));
  console.log('[cpu] ' + m.trim());
  // also a quick functional check: run a command in the workspace through opencode's host
  const fn = await ptExec(probe, 'echo OK_$(whoami)_$(ls /workspace 2>/dev/null | head -1)');
  console.log('[func] ' + fn.trim());
}

// cleanup ONLY the sandboxes I created
for (const ext of created) await fetch(`${PT}/v1/sandboxes/${ext}`, { method: 'DELETE', headers: PTH }).catch(() => {});
console.log(`\ncleaned ${created.length} sandboxes`);
const ok = runs.filter((x) => x > 0);
if (ok.length) {
  const s = [...ok].sort((a, b) => a - b);
  console.log(`RESULT n=${ok.length}/${N} p50=${(s[Math.floor(s.length / 2)] / 1000).toFixed(2)}s min=${(s[0] / 1000).toFixed(2)}s max=${(s[s.length - 1] / 1000).toFixed(2)}s`);
}
process.exit(0);
