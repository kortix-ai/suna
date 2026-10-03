#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runLocalTests } from '../src/core/local-runner';

const root = resolve(import.meta.dir, '../..');
// The Agent Computer Tunnel reads its owner's answer from ~/.agent-tunnel
// (access.json). A developer running the desktop app has `ask` there, and a
// lapsed grant held every tunnel call in TUN-6 for 20 s. Every lane inherits
// this: tests never read a person's real tunnel state.
process.env.AGENT_TUNNEL_HOME ||= mkdtempSync(join(tmpdir(), 'ke2e-agent-tunnel-'));
// Hermeticity: drop the platform sandbox's identity. Inside a Kortix agent
// sandbox the entrypoint exports the box's runtime identity under KORTIX_*
// (KORTIX_SUPERVISED, KORTIX_TOKEN, KORTIX_API_URL, KORTIX_PROJECT_ID,
// KORTIX_BASE_SHA, KORTIX_BASE_REF, KORTIX_SESSION_ID, …) and also writes it
// to /dev/shm/kortix/agent-env.sh, which `sandboxEnvValue` honors. CI runs
// with none of these, so a test that reads them tests the sandbox, not the
// product: the compiled runtimes fail their own baked-identity checks, the
// CLI scopes every connector call at the sandbox's project, and the
// supervised self-update gates fire. Delete every KORTIX_* var the suite does
// not pass through on purpose so every lane runs exactly what CI runs.
// Tests that exercise the sandbox behavior set the vars themselves
// (supervised-binaries.test.ts) or opt back in explicitly.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('KORTIX_') && name !== 'KORTIX_PACKAGE_SKIP_SDK_TESTS') {
    delete process.env[name];
  }
}
// The sandbox env file (/dev/shm/kortix/agent-env.sh) would re-inject the
// identity through `sandboxEnvValue` even with the vars deleted above.
process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
process.exitCode = await runLocalTests(root, process.argv.slice(2));
