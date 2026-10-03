#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runLocalTests } from '../src/core/local-runner';
import { scrubSandboxInjectedEnv } from '../src/core/hermetic-sandbox-env';

const root = resolve(import.meta.dir, '../..');
// The Agent Computer Tunnel reads its owner's answer from ~/.agent-tunnel
// (access.json). A developer running the desktop app has `ask` there, and a
// lapsed grant held every tunnel call in TUN-6 for 20 s. Every lane inherits
// this: tests never read a person's real tunnel state.
process.env.AGENT_TUNNEL_HOME ||= mkdtempSync(join(tmpdir(), 'ke2e-agent-tunnel-'));
// Same shape: a Kortix sandbox exports ambient platform state (supervised
// flag, session/project ids, tokens, the agent-env file) that tests adopt as
// if it were the machine's own. Absent on a developer machine and CI, so the
// scrub is a no-op there. See tests/src/core/hermetic-sandbox-env.ts.
scrubSandboxInjectedEnv();
process.exitCode = await runLocalTests(root, process.argv.slice(2));
