import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readWorkflow } from '../src/fixtures/repo';

const workflows = resolve(REPO_ROOT, '.github/workflows');

/**
 * A deploy workflow QUEUES; it never cancels an in-flight run.
 *
 * GitHub keeps one running and one pending run per concurrency group, and a
 * newer pending run replaces the older pending one, so a burst of pushes still
 * collapses to one deploy of the newest commit. `cancel-in-progress: true`
 * instead restarts the pipeline on every push: Deploy Dev starved on
 * 2026-08-10 (3.5 h stale) and again 2026-09-19..26 (90 of 235 runs cancelled,
 * merge -> live p90 28.8 min), and a cancel can kill `migrate-db` mid-run.
 * The 2026-08-11 learning had no enforcer, and d8847d39ba flipped Deploy Dev
 * back nine days later. This is the enforcer.
 */
describe('deploy workflows queue instead of cancelling', () => {
  const files = readdirSync(workflows).filter((name) => /^deploy-.*\.ya?ml$/.test(name));

  it('finds the deploy workflows', () => {
    expect(files).toEqual(expect.arrayContaining(['deploy-dev.yml', 'deploy-staging.yml', 'deploy-prod.yml']));
  });

  for (const name of files) {
    it(`${name} never sets cancel-in-progress: true`, () => {
      const source = readWorkflow(name);
      const settings = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .filter((line) => /^\s*cancel-in-progress:/.test(line));
      for (const line of settings) expect(line.trim()).toBe('cancel-in-progress: false');
    });
  }
});

/**
 * A rollback and a release roll the same prod ECS services and Vercel
 * production. Before 2026-11-06 they had separate groups, so a rollback
 * dispatched during a release roll raced it. One group serializes them.
 */
describe('rollback-prod and deploy-prod share one concurrency group', () => {
  const group = (name: string) =>
    /^concurrency:\n(?: {2}#.*\n)* {2}group: (\S+)\n {2}cancel-in-progress: false$/m.exec(
      readWorkflow(name),
    )?.[1];

  it('uses the deploy-prod group in both files', () => {
    expect(group('deploy-prod.yml')).toBe('deploy-prod');
    expect(group('rollback-prod.yml')).toBe('deploy-prod');
  });

  it('documents the ref the prod environment admits', () => {
    const source = readWorkflow('rollback-prod.yml');
    expect(source).toContain('rollback-prod.yml --repo kortix-ai/CompanyOS --ref prod');
    expect(source).not.toContain('--ref dev');
  });
});
