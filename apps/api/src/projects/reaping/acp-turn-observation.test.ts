import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { isTurnStartRequest } from '../sandbox-deadline';

const API_SRC = join(import.meta.dir, '..', '..');
const REAPING_DIR = import.meta.dir;
const HEADLESS_ACP = join(API_SRC, 'projects/session-lifecycle/headless-acp.ts');
const ENGINE = join(API_SRC, 'projects/session-lifecycle/engine.ts');
const ACP_ROUTE = join(API_SRC, 'projects/routes/acp.ts');

const SANDBOX_SELF_REPORTS = [
  'probeSandboxBusy',
  '/session/status',
  'acp_busy',
  'acp_ready',
  'executionLeaseUntil',
  'hasActiveExecutionLease',
];

const DELETED_SELF_REPORT_MODULES = [
  join(API_SRC, 'projects/sandbox-busy-probe.ts'),
  join(REAPING_DIR, 'running-box.ts'),
];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walk(full);
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) yield full;
  }
}

function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('*') && !line.startsWith('//'));
}

describe('the reaper judges an ACP box on nothing the box reports about itself', () => {
  test.each(DELETED_SELF_REPORT_MODULES)('%s stays deleted', (path) => {
    expect(existsSync(path)).toBe(false);
  });

  test('no reaper decision module reads a sandbox self-reported busy signal', async () => {
    const offenders: Array<{ file: string; token: string }> = [];
    for await (const file of walk(REAPING_DIR)) {
      for (const line of codeLines(await Bun.file(file).text())) {
        for (const token of SANDBOX_SELF_REPORTS) {
          if (line.includes(token)) offenders.push({ file: relative(API_SRC, file), token });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('every managed-ACP prompt path yields a control-plane turn-start observation', () => {
  test('the headless relay route is classified as a turn start on the daemon port', async () => {
    const source = await Bun.file(HEADLESS_ACP).text();
    const template = /const route = `([^`]+)`/.exec(source)?.[1];
    const route = template?.replace(/\$\{[^}]*\}/g, 'acp-server-1');

    expect(route).toBe('/kortix/acp/acp-server-1');
    expect(isTurnStartRequest(8000, 'POST', route as string)).toBe(true);
  });

  test('the headless relay declares itself control-plane authored, never sandbox authored', async () => {
    const source = await Bun.file(ENGINE).text();
    const relay = /return deliverHeadlessAcpPrompt\([\s\S]*?\n {2}\}\);/.exec(source)?.[0];

    expect(relay).toBeTruthy();
    expect(relay).toContain('sandboxAuthored: false');
    expect(relay).not.toContain('sandboxAuthored: true');
  });

  test('the web ACP route awaits observeTurnStart before relaying a session/prompt', async () => {
    const lines = codeLines(await Bun.file(ACP_ROUTE).text()).filter(
      (line) => !line.startsWith('import'),
    );

    expect(lines.some((line) => line.includes("envelope.method === 'session/prompt'"))).toBe(true);
    expect(lines.some((line) => line.includes('await observeTurnStart('))).toBe(true);
    expect(lines.some((line) => line.includes('isSandboxAuthored('))).toBe(true);
  });
});
