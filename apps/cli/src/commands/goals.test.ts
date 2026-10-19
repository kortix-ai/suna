import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalViolations, slugify, takeEnforcementSlot, type GoalFacts } from './goals';

const base = {
  version: 1,
  objective: 'Rho account closed',
  status: 'active',
  success_criteria: [{ id: 'c1', text: 'Rho confirms in writing', met: false, evidence: null }],
  items: [{ id: 'i1', kind: 'ask', title: 'Approve 2FA', status: 'open' }],
  sessions: [{ id: 'coord', role: 'coordinator' }],
  reminder_id: 'reminder.a',
  verified_by: null,
};
const healthy: GoalFacts = { activeHeartbeats: ['reminder.a'], unattended: true, verification: null };

describe('goalViolations', () => {
  test('a sound open goal passes', () => {
    expect(goalViolations(base, healthy)).toEqual([]);
  });

  test('an open goal without a heartbeat, or not unattended, fails with the fix', () => {
    const v = goalViolations(base, { ...healthy, activeHeartbeats: [], unattended: false });
    expect(v.join('\n')).toContain('no heartbeat reminder is active');
    expect(v.join('\n')).toContain('kortix sessions update --meta unattended=true');
  });

  test('done needs an independent PASS and no heartbeat left', () => {
    const done = { ...base, status: 'done', verified_by: 'coord' };
    const v = goalViolations(done, { ...healthy, verification: 'c1: FAIL' });
    expect(v.join('\n')).toContain('not PASS on every criterion');
    expect(v.join('\n')).toContain('only a session that did none of the work may verify');
    expect(v.join('\n')).toContain('still active');
    expect(goalViolations({ ...done, verified_by: 'verifier' }, { activeHeartbeats: [], unattended: true, verification: 'c1: PASS' })).toEqual([]);
  });

  test('schema: version, status, criteria and item enums', () => {
    const v = goalViolations({ ...base, version: 2, status: 'finished', success_criteria: [], items: [{ id: 'x', kind: 'todo', status: 'later' }] }, healthy);
    expect(v).toHaveLength(5);
    expect(goalViolations(null, healthy)).toEqual(['goal.json is not a JSON object.']);
  });
});

test('slugify keeps the first five words', () => {
  expect(slugify('Secure €2.5M EIC Accelerator funding for the company')).toBe('secure-2-5m-eic-accelerator');
});

test('enforcement is capped at 3 prompts per goal per 6 hours', () => {
  const state = join(mkdtempSync(join(tmpdir(), 'goal-check-')), 'state.json');
  const t = 1_000_000_000_000;
  expect([1, 2, 3, 4].map((i) => takeEnforcementSlot('/g', t + i, state))).toEqual([true, true, true, false]);
  expect(takeEnforcementSlot('/other', t, state)).toBe(true);
  expect(takeEnforcementSlot('/g', t + 6 * 60 * 60_000 + 10, state)).toBe(true);
});

test('the real CLI lists and shows goals from the mounted folders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drives-'));
  const folder = join(root, 'me', 'Goals', 'rho-close');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'goal.json'), JSON.stringify({ ...base, summary: 'Closure requested.', next_wake_at: '2026-10-20T09:00:00Z' }));
  const run = (args: string[]) =>
    Bun.spawnSync(['bun', join(import.meta.dir, '..', 'index.ts'), 'goals', ...args], { env: { ...process.env, KORTIX_DRIVES_ROOT: root } });
  const ls = run(['ls', '--json']);
  expect(ls.exitCode).toBe(0);
  expect(JSON.parse(ls.stdout.toString()).goals[0]).toMatchObject({ slug: 'rho-close', status: 'active', criteria_total: 1, criteria_met: 0 });
  const st = run(['status', 'rho-close']);
  expect(st.exitCode).toBe(0);
  expect(st.stdout.toString()).toContain('Approve 2FA');
  const missingRoot = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'index.ts'), 'goals', 'ls'], { env: { ...process.env, KORTIX_DRIVES_ROOT: join(root, 'nope') } });
  expect(missingRoot.exitCode).toBe(2);
  expect(missingRoot.stderr.toString() + missingRoot.stdout.toString()).toContain('Files is not mounted here');
});
