#!/usr/bin/env bun
/** Disposable Platinum workload benchmark. Live mode incurs sandbox charges. */
import { PlatinumApi, exec } from '../src/core/platinum-ci';

export const sizesGb = [2, 4, 8, 16, 24, 36] as const;
export const workloads = [
  { name: 'agents', percent: 30, command: 'for i in $(seq 1 100000); do echo "$i" | sha256sum >/dev/null; done' },
  { name: 'web', percent: 25, command: 'python3 -m http.server 18765 >/tmp/eval-web.log 2>&1 & pid=$!; sleep 1; curl -fsS http://127.0.0.1:18765 >/dev/null; result=$?; kill "$pid"; exit "$result"' },
  { name: 'heavy', percent: 25, command: 'python3 -c "import hashlib; print(hashlib.pbkdf2_hmac(\"sha256\", b\"test\", b\"salt\", 1000000).hex()[:8])"' },
  { name: 'rl', percent: 15, command: 'python3 -c "import random; r=random.Random(42); q=[0.0]*1000; [q.__setitem__(r.randrange(1000),r.random()) for _ in range(100000)]; print(sum(q))"' },
  { name: 'oom', percent: 5, command: 'ulimit -v 32768; python3 -c "bytearray(64*1024*1024)"' },
] as const;

export function plan(count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error('count must be 1..1000');
  return Array.from({ length: count }, (_, i) => {
    const percentile = ((i * 37) % count + 0.5) / count * 100;
    let cumulative = 0;
    const workload = workloads.find((item) => (cumulative += item.percent) > percentile) ?? workloads.at(-1)!;
    return { index: i, sizeGb: sizesGb[i % sizesGb.length], workload };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const countIndex = args.indexOf('--count');
  const count = countIndex === -1 ? 60 : Number(args[countIndex + 1]);
  const cases = plan(count);
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ mode: 'dry-run', distribution: workloads.map(({ name, percent }) => ({ name, percent })), cases: cases.map(({ index, sizeGb, workload }) => ({ index, sizeGb, workload: workload.name })) }, null, 2));
    return;
  }
  const key = process.env.PLATINUM_API_KEY;
  const template = process.env.PLATINUM_EVAL_TEMPLATE_ID;
  if (!key || !template) throw new Error('live mode requires PLATINUM_API_KEY and PLATINUM_EVAL_TEMPLATE_ID');
  if (!args.includes('--confirm-cost')) throw new Error('live mode requires --confirm-cost');
  const api = new PlatinumApi(process.env.PLATINUM_API_URL || 'https://api.platinum.dev', key);
  for (const sample of cases) {
    let sandboxId = '';
    const started = Date.now();
    try {
      const box = await api.json<{ id: string }>(
        '/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000',
        { method: 'POST', body: JSON.stringify({ name: `kortix-eval-${crypto.randomUUID()}`, template, type: 'persistent', cpu: 2, ram_mb: sample.sizeGb * 1024, disk_gb: 50, auto_stop_minutes: 10, auto_delete_days: 1, metadata: { owner: 'kortix-eval' } }) },
      );
      sandboxId = box.id;
      const createdMs = Date.now() - started;
      const result = await exec(api, sandboxId, ['bash', '-lc', sample.workload.command]);
      const ok = sample.workload.name === 'oom' ? result.exit_code !== 0 : result.exit_code === 0;
      console.log(JSON.stringify({ index: sample.index, sizeGb: sample.sizeGb, workload: sample.workload.name, createdMs, totalMs: Date.now() - started, exitCode: result.exit_code ?? -1, ok }));
    } catch (error) {
      console.log(JSON.stringify({ index: sample.index, sizeGb: sample.sizeGb, workload: sample.workload.name, totalMs: Date.now() - started, ok: false, error: error instanceof Error ? error.name : 'UnknownError' }));
    } finally {
      if (sandboxId) await api.json(`/v1/sandboxes/${sandboxId}`, { method: 'DELETE' });
    }
  }
}

if (import.meta.main) main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
