#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runLocalTests } from '../src/core/local-runner';

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
