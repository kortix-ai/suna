import { describe, expect, test } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, readWorkflow } from '../src/fixtures/repo';

// A `workflow_run` trigger matches the triggering workflow by NAME. A pull
// request can run its own copy of a workflow with that name, and its run then
// starts the follower in the base repository, with its secrets. A follower that
// checks out `github.event.workflow_run.head_sha` therefore runs that pull
// request's code with production credentials unless it pins the branch and
// proves the commit belongs to it (PR #11646; Mobile OTA had this hole).
const dir = resolve(REPO_ROOT, '.github/workflows');
const followers = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, source: readWorkflow(name) }))
  .filter(({ source }) => /^ {2}workflow_run:/m.test(source) && source.includes('workflow_run.head_sha'));

describe('workflow_run followers that run the triggering commit', () => {
  test('exist (the scan finds the mobile and staging deploy followers)', () => {
    expect(followers.map((f) => f.name)).toEqual(
      expect.arrayContaining(['deploy-staging.yml', 'mobile-ota.yml', 'mobile-store.yml']),
    );
  });

  for (const { name, source } of followers) {
    test(`${name} pins the trigger to a branch`, () => {
      const trigger = source.slice(source.search(/^ {2}workflow_run:/m)).split(/\n {2}\S/)[0];
      expect(trigger).toMatch(/^ {4}branches: \[[^\]]+\]$/m);
    });

    test(`${name} proves the commit belongs to that branch before running it`, () => {
      expect(source).toMatch(/git merge-base --is-ancestor/);
    });
  }
});
