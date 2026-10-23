/**
 * The release gate's API lane runs only the flows tagged `deployed`
 * (`DEPLOYED_FLOW_TAG`, `--target-api-full`). The `Tests` lanes already ran
 * every flow on the same tree, so the gate proves only what a deployment can
 * break. This file pins that set: each deployed seam keeps at least one flow,
 * and the set stays small enough for one API job of about 5 minutes.
 *
 * The seam table here is the source of the table in tests/README.md
 * ("Release gate"). Change both together.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEPLOYED_FLOW_TAG } from '../src/core/local-runner';

const SEAMS: Record<string, string[]> = {
  'health, deployed SHA, edge error shape': ['SYS-1', 'SYS-8', 'SYS-5', 'GW-1', 'GW-1b'],
  'auth and JWT against the real Supabase': ['AUTH-3', 'AUTH-1', 'ME-1', 'TOK-3'],
  'email delivery': ['AUTH-2', 'AUTH-4'],
  'CORS, cookies, domains': ['PRX-1', 'PRX-3', 'OAU-5', 'MCP-1'],
  'sandbox boot and the runtime proxy': ['RUN-2', 'RUN-8'],
  'SSE through the edge': ['RUN-3'],
  'sandbox stop and wake': ['SESS-12'],
  'LLM gateway': ['GW-2', 'GW-MANAGED-1'],
  'Stripe and billing webhooks': ['BILL-1', 'BILL-3', 'BILL-8', 'BILL-18'],
  'object storage and uploads': ['SESS-31', 'SESS-31-log', 'FILE-9'],
  'git push to managed repositories': ['SHIP-1', 'RUN-7', 'GH-19', 'FILE-1'],
  'money path: prompt to merged change request, real CLI': ['GOLD-1', 'CLI-SESS'],
  'MCP over HTTP with a PAT': ['MCP-4'],
  'Apps edge host check': ['APP-5'],
  'provider webhook secrets': ['SBX-6'],
  'web push keys': ['NOTIF-4'],
  'internal cron key': ['BILL-13'],
  'database writes over the deployed pool': ['ACCT-2', 'PROJ-1'],
};

interface TaggedFlow {
  id: string;
  todo: boolean;
}

/** Bun-only registry (see unit/shard.test.ts), read in a `bun` subprocess. */
function deployedFlows(): TaggedFlow[] {
  const testsDir = resolve(import.meta.dirname, '..');
  const script = `
    const { discoverFlows } = await import(${JSON.stringify(`${testsDir}/src/core/runner.ts`)});
    const { allFlows } = await import(${JSON.stringify(`${testsDir}/src/core/flow.ts`)});
    await discoverFlows();
    console.log(JSON.stringify(allFlows()
      .filter((f) => (f.meta.tags ?? []).includes(${JSON.stringify(DEPLOYED_FLOW_TAG)}))
      .map((f) => ({ id: f.id, todo: Boolean(f.meta.todo) }))));
  `;
  const out = execFileSync('bun', ['-e', script], { encoding: 'utf8', cwd: testsDir });
  return JSON.parse(out.trim().split('\n').at(-1) as string) as TaggedFlow[];
}

describe('the deployed flow set', () => {
  let flows: TaggedFlow[] = [];
  beforeAll(() => {
    flows = deployedFlows();
  }, 120_000);

  it('is exactly the flows the seam table names', () => {
    const tagged = flows.map((f) => f.id).sort();
    const listed = Object.values(SEAMS).flat().sort();
    expect(new Set(listed).size, 'a flow listed under two seams').toBe(listed.length);
    expect(tagged).toEqual(listed);
  });

  it('stays a smoke: 30 to 50 flows', () => {
    expect(flows.length).toBeGreaterThanOrEqual(30);
    expect(flows.length).toBeLessThanOrEqual(50);
  });

  it('holds no todo flow, so --require-all means every seam ran', () => {
    expect(flows.filter((f) => f.todo).map((f) => f.id)).toEqual([]);
  });
});
