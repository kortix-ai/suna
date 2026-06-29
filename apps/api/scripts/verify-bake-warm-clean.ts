/**
 * Bulletproof single cold-boot measurement on a fresh box. Reports the poll
 * iteration at which /session first answered + raw nanos + who owned port 4096
 * BEFORE we started our server, so an identical-looking number can't be a
 * daemon-respawn artifact.
 *
 *   cd apps/api && KORTIX_URL=x pnpm exec dotenvx run -f .env -- \
 *     bun run scripts/verify-bake-warm-clean.ts kortix-default-84c960908f77
 */
import { readFileSync } from 'node:fs';
import { getDaytona } from '../src/shared/daytona';

const SNAPSHOT = process.argv[2] || 'kortix-default-84c960908f77';

const SCRIPT = [
  'set +e',
  '# stage the real cloned config + daemon-faithful node_modules symlink',
  'pkill -9 -f kortix-agent 2>/dev/null; pkill -9 -f opencode 2>/dev/null; sleep 2',
  'rm -rf /workspace/.kortix/opencode 2>/dev/null; mkdir -p /workspace/.kortix/opencode',
  'tar -xzf /tmp/oc-config.tar.gz -C /workspace/.kortix/opencode',
  'ln -sfn /opt/kortix/opencode-config-deps/node_modules /workspace/.kortix/opencode/node_modules',
  'echo "skills=$(ls /workspace/.kortix/opencode/skills | wc -l) tools=$(ls /workspace/.kortix/opencode/tools | wc -l)"',
  'echo "port4096 owner BEFORE: $(ss -ltnp 2>/dev/null | grep -c :4096) listener(s)"',
  'echo "opencode procs BEFORE: $(pgrep -af opencode | wc -l)"',
  'echo "--- starting our own opencode serve ---"',
  'T0=$(date +%s%N)',
  'setsid opencode serve --port 4096 </dev/null >/tmp/oc.log 2>&1 &',
  'HIT=-1',
  'for i in $(seq 1 700); do if curl -sf "http://127.0.0.1:4096/session?directory=/workspace" >/tmp/sess.json 2>/dev/null; then HIT=$i; break; fi; sleep 0.1; done',
  'T1=$(date +%s%N)',
  'echo "hit_iteration=$HIT (each ~100ms)"',
  'echo "session_ready_ms=$(( (T1 - T0) / 1000000 ))"',
  'echo "resp=$(head -c 80 /tmp/sess.json)"',
  'echo "--- oc.log tail ---"; tail -14 /tmp/oc.log',
  'pkill -9 -f opencode 2>/dev/null',
].join('\n');

async function main() {
  const daytona = getDaytona();
  console.log(`=== fresh box from ${SNAPSHOT} ===`);
  const t = Date.now();
  const sb = await daytona.create({ snapshot: SNAPSHOT }, { timeout: 120 });
  console.log(`  created in ${((Date.now() - t) / 1000).toFixed(1)}s (id=${sb.id})`);
  try {
    await sb.fs.uploadFile(readFileSync('/tmp/oc-config.tar.gz'), '/tmp/oc-config.tar.gz');
    const b64 = Buffer.from(SCRIPT, 'utf8').toString('base64');
    const r = await sb.process.executeCommand(`echo ${b64} | base64 -d | bash`, undefined, undefined, 100);
    console.log('\n' + (r.result || '').trim());
  } finally {
    await sb.delete().catch(() => {});
    console.log('\n(box deleted)');
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('failed:', err instanceof Error ? (err.stack || err.message) : err);
  process.exit(1);
});
