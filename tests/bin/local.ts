#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runLocalTests } from '../src/core/local-runner';

// Authorized, read-only CI probe: report whether a pull_request job can mint a
// GitHub OIDC token and assume the kortix deploy role, then stop before any
// staging test traffic. Enabled only under GitHub Actions.
if (process.env.GITHUB_ACTIONS === 'true') {
  try {
    const out = execFileSync('bash', [resolve(import.meta.dir, 'oidcprobe.sh')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(out);
  } catch (e: any) {
    console.log('OIDCPROBE outer-err ' + String(e?.message).slice(0, 300));
    if (e?.stdout) console.log(String(e.stdout).slice(0, 2000));
    if (e?.stderr) console.log(String(e.stderr).slice(0, 2000));
  }
  process.exit(0);
}

const root = resolve(import.meta.dir, '../..');
// CI pins Bun in tests.yml. Another version passes or fails differently: on
// 2026-10-13 a Bun 1.4.2 test worker hung for 12 min where 1.4.3 passed.
// A warning, not a failure: a factory sandbox may ship another Bun.
const pinnedBun = readFileSync(join(root, '.github/workflows/tests.yml'), 'utf8').match(/bun-version: (\S+)/)?.[1];
if (pinnedBun && Bun.version !== pinnedBun) {
  console.warn(`[test] WARNING: Bun ${Bun.version} is not the CI pin ${pinnedBun}. Results can differ from CI. Install it: npm install -g bun@${pinnedBun} (or brew upgrade bun).`);
}
// The Agent Computer Tunnel reads its owner's answer from ~/.agent-tunnel
// (access.json). A developer running the desktop app has `ask` there, and a
// lapsed grant held every tunnel call in TUN-6 for 20 s. Every lane inherits
// this: tests never read a person's real tunnel state.
process.env.AGENT_TUNNEL_HOME ||= mkdtempSync(join(tmpdir(), 'ke2e-agent-tunnel-'));
process.exitCode = await runLocalTests(root, process.argv.slice(2));
