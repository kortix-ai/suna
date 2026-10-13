import { describe, expect, it } from 'vitest';
import { buildLocalTestPlan } from '../src/core/local-runner';
import { type WorkspaceGraph, scopeFor, scopePlan } from '../src/core/test-scope';

// A slice of the real workspace graph (`pnpm ls --filter "...{dir}"`).
const DIRS = [
  '',
  'tests',
  'apps/api',
  'apps/cli',
  'apps/tui',
  'apps/web',
  'apps/mobile',
  'apps/kortix-sandbox-agent-server',
  'packages/sdk',
  'packages/db',
  'packages/api-contract',
];
const DEPENDENTS: Record<string, string[]> = {
  'apps/cli': ['apps/cli', 'apps/tui'],
  'packages/db': ['packages/db', 'apps/api'],
  'packages/api-contract': ['packages/api-contract', 'apps/api', 'tests'],
  'packages/sdk': [
    'packages/sdk',
    'apps/api',
    'apps/cli',
    'apps/tui',
    'apps/mobile',
    'apps/web',
    'tests',
  ],
};
const graph: WorkspaceGraph = {
  packageDirs: DIRS,
  dependentsOf: (dirs) => dirs.flatMap((dir) => DEPENDENTS[dir] ?? [dir]),
  // kortixd reaches api-contract through a tsconfig path, not a dependency.
  importersOf: (dir) =>
    dir === 'packages/api-contract' ? ['apps/kortix-sandbox-agent-server'] : [],
  mentionsOf: (path) => (path === '.github/workflows/tests.yml' ? ['apps/web', 'apps/api'] : []),
};
const scope = (...files: string[]) => scopeFor(files, graph);
const lanes = (plan: { stages: { name: string }[][] }) =>
  plan.stages.map((s) => s.map((l) => l.name));

describe('diff-scoped core run', () => {
  it('a web-only diff runs web package tests and skips the flows, DB suites and SDK', () => {
    expect(scope('apps/web/src/app/page.tsx')).toEqual({
      full: false,
      packages: ['apps/web'],
      flows: false,
      sdk: false,
    });
  });

  it('an API diff runs the flows and DB suites; a schema diff reaches the API through the graph', () => {
    expect(scope('apps/api/src/app.ts')).toMatchObject({
      packages: ['apps/api'],
      flows: true,
      sdk: false,
    });
    expect(scope('packages/db/src/schema.ts')).toMatchObject({
      packages: ['apps/api', 'packages/db'],
      flows: true,
    });
  });

  it('an SDK diff runs the SDK and every dependent, never the runner workspace', () => {
    const s = scope('packages/sdk/src/index.ts');
    expect(s).toMatchObject({ flows: true, sdk: true });
    expect(s.full === false && s.packages).toEqual([
      'apps/api',
      'apps/cli',
      'apps/mobile',
      'apps/tui',
      'apps/web',
      'packages/sdk',
    ]);
  });

  it('docs, skills and runner unit tests run only the always-on lanes', () => {
    expect(scope('AGENTS.md', '.agents/skills/testing/SKILL.md', 'tests/unit/x.test.ts')).toEqual({
      full: false,
      packages: [],
      flows: false,
      sdk: false,
    });
  });

  it('a workflow or Terraform edit runs the packages whose files name it, and nothing for an unread one', () => {
    expect(scope('.github/workflows/tests.yml')).toEqual({
      full: false,
      packages: ['apps/api', 'apps/web'],
      flows: true,
      sdk: false,
    });
    expect(scope('infra/terraform/modules/x/main.tf')).toEqual({
      full: false,
      packages: [],
      flows: false,
      sdk: false,
    });
  });

  it('a relative import pnpm cannot see still pulls the importer in', () => {
    expect(scope('packages/api-contract/src/transcript.ts')).toMatchObject({
      packages: ['apps/api', 'apps/kortix-sandbox-agent-server', 'packages/api-contract'],
    });
  });

  it('flow and spec edits run the flows without any package', () => {
    expect(scope('tests/src/flows/auth.flow.ts', 'tests/spec/end-to-end.md')).toEqual({
      full: false,
      packages: [],
      flows: true,
      sdk: false,
    });
  });

  it('anything unrecognised runs everything: root config, the runner, scripts, non-package dirs', () => {
    for (const file of [
      'pnpm-lock.yaml',
      'package.json',
      'tests/src/core/local-runner.ts',
      'scripts/dev-local.sh',
      'apps/sandbox/Dockerfile',
      'supabase/config.toml',
    ]) {
      expect(scope('apps/web/x.ts', file)).toMatchObject({ full: true });
    }
    expect(scopeFor(null, graph)).toMatchObject({ full: true });
  });

  it('scopePlan drops unaffected lanes, runs the cheap lanes beside package quality, and passes the scope', () => {
    const { plan, unaffected, reused } = scopePlan(
      buildLocalTestPlan([]),
      scope('apps/web/a.ts'),
      {},
    );
    expect(unaffected).toEqual(['api-cli-flows', 'db-suites', 'sdk']);
    expect(reused).toEqual([]);
    expect(lanes(plan)).toEqual([
      ['flow-runner-unit', 'route-coverage', 'worktree-unit', 'package-quality'],
    ]);
    const pq = plan.lanes.find((l) => l.name === 'package-quality');
    expect(pq?.env).toEqual({
      KORTIX_PACKAGE_SKIP_SDK_TESTS: '1',
      KORTIX_TEST_SCOPE: '["apps/web"]',
    });
  });

  it('scopePlan keeps the full plan for a full scope and reuses only groups that passed', () => {
    const full = buildLocalTestPlan([]);
    const { plan, reused } = scopePlan(
      full,
      { full: true, reason: 'CI' },
      {
        core: 'pass',
        packages: 'fail',
        'db-suites': 'skipped-no-db',
      },
    );
    expect(reused).toEqual(['core']);
    expect(lanes(plan)).toEqual([['api-cli-flows', 'db-suites'], ['package-quality']]);
    expect(plan.lanes.find((l) => l.name === 'package-quality')?.env).toEqual({
      KORTIX_PACKAGE_SKIP_SDK_TESTS: '1',
    });
  });
});
