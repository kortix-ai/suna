import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/tests.yml'),
  'utf8',
);
const job = (name: string) => workflow.split(`\n  ${name}:\n`)[1].split(/\n {2}[\w-]+:\n/)[0];
const condition = (name: string) => {
  const lines = job(name).split('\n');
  const at = lines.findIndex((line) => line.startsWith('    if:'));
  const first = lines[at].slice(8).trim();
  return first === '>-'
    ? lines
        .slice(at + 1)
        .filter((line) => line.startsWith('      '))
        .slice(0, 3)
        .join(' ')
        .trim()
    : first;
};
const context = (event: string, action = '', base = '', label = '', sha = 'a'.repeat(40)) => ({
  github: {
    event_name: event,
    ref: event === 'pull_request' ? 'refs/pull/7/merge' : 'refs/heads/dev',
    sha,
    base_ref: base,
    event: { action, label: { name: label } },
  },
});
// These workflow expressions use only JS-compatible comparisons, booleans,
// property access and cancelled(). Execute the actual expression, not a replica.
const evaluate = (expression: string, values: object) =>
  runInNewContext(expression, {
    ...values,
    format: (template: string, value: string) => template.replace('{0}', value),
  });
const group = (values: object) => {
  const template = workflow.split('\nconcurrency:\n')[1].split('\n')[0].trim().slice(7);
  return template.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) =>
    String(evaluate(expression, values)),
  );
};

describe('trunk event behavior', () => {
  test.each(['push', 'schedule', 'workflow_dispatch'])('%s runs the lanes', (event) => {
    expect(evaluate(condition('lane'), context(event))).toBe(true);
  });
  test.each(['opened', 'reopened', 'synchronize', 'ready_for_review', 'labeled'])(
    'PR %s preserves opt-in and release gates',
    (action) => {
      expect(evaluate(condition('lane'), context('pull_request', action, 'dev', 'other'))).toBe(
        false,
      );
      expect(evaluate(condition('lane'), context('pull_request', action, 'staging', 'other'))).toBe(
        action !== 'labeled',
      );
      if (action === 'labeled')
        expect(evaluate(condition('lane'), context('pull_request', action, 'dev', 'test'))).toBe(
          true,
        );
    },
  );
  test('three pushed SHAs have independent groups; a PR update cannot cancel a label run', () => {
    expect(
      new Set(['a', 'b', 'c'].map((sha) => group(context('push', '', '', '', sha.repeat(40)))))
        .size,
    ).toBe(3);
    expect(group(context('pull_request', 'labeled'))).not.toBe(
      group(context('pull_request', 'synchronize')),
    );
    const cancel = workflow
      .split('  cancel-in-progress: ')[1]
      .split('\n')[0]
      .replace(/\$\{\{|\}\}/g, '');
    expect(evaluate(cancel, context('push'))).toBe(false);
    expect(evaluate(cancel, context('pull_request'))).toBe(true);
  });
  test.each(['push', 'schedule', 'pull_request', 'workflow_dispatch'])(
    '%s reports only non-cancelled red trunk runs',
    (event) => {
      for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
        for (const cancelled of [false, true]) {
          expect(
            evaluate(condition('trunk-report'), {
              ...context(event),
              needs: { lane: { result } },
              cancelled: () => cancelled,
            }),
          ).toBe((event === 'push' || event === 'schedule') && result !== 'success' && !cancelled);
        }
      }
    },
  );
});

const reporter = workflow
  .split('      - name: Report the trunk verdict\n')[1]
  .split('        run: |\n')[1]
  .split('\n')
  .map((line) => line.slice(10))
  .join('\n');
const sha = 'a'.repeat(40);
const green = 'b'.repeat(40);

// Execute the shipped bash and its jq queries. Only GitHub is replaced: no
// network writes from a unit test. Cases stay serial (the reporter has a fixed tmp path).
test('the real reporter rejects newer/same/PR greens and comments even when lookups fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trunk-verdict-'));
  try {
    writeFileSync(
      join(dir, 'gh'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FIXTURE/requests"
endpoint="$2"
query=""
for ((i=1; i<=$#; i++)); do
  if [ "\${!i}" = '--jq' ]; then j=$((i+1)); query="\${!j}"; fi
done
case "$endpoint" in
  */jobs) [ "$CASE" != lookup-failure ] || exit 1; data='{"jobs":[{"name":"core lane","conclusion":"failure"},{"name":"browser-2 lane","conclusion":"cancelled"},{"name":"packages lane","conclusion":"success"},{"name":"skipped lane","conclusion":"skipped"},{"name":"trunk verdict","conclusion":"failure"}]}' ;;
  *workflows/tests.yml/runs*) [ "$CASE" != lookup-failure ] || exit 1; data="$(cat "$FIXTURE/runs.json")" ;;
  *compare/*) case "$endpoint" in
    *newer*) data='{"status":"behind","commits":[]}' ;;
    *${sha}...*) data='{"status":"identical","commits":[]}' ;;
    *${green}...*) data='{"status":"ahead","commits":[{"sha":"cccccccccccccccccccccccccccccccccccccccc","commit":{"message":"fix: synthetic regression"},"author":{"login":"synthetic"}}]}' ;;
    *) exit 9 ;;
    esac ;;
  */comments) for arg in "$@"; do case "$arg" in body=@*) cp "\${arg#body=@}" "$FIXTURE/comment";; esac; done; echo https://example.test/comment; exit 0 ;;
  *) exit 9 ;;
esac
if [ -n "$query" ]; then printf '%s' "$data" | jq -r "$query"; else printf '%s' "$data"; fi
`,
      { mode: 0o755 },
    );
    for (const scenario of ['normal', 'no-green', 'lookup-failure']) {
      writeFileSync(join(dir, 'requests'), '');
      writeFileSync(
        join(dir, 'runs.json'),
        JSON.stringify({
          workflow_runs:
            scenario === 'no-green'
              ? []
              : [
                  { head_sha: 'newer', event: 'push' },
                  { head_sha: sha, event: 'schedule' },
                  { head_sha: 'pr-green', event: 'pull_request' },
                  { head_sha: green, event: 'push' },
                ],
        }),
      );
      const result = spawnSync('bash', ['-c', reporter], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          FIXTURE: dir,
          CASE: scenario,
          REPO: 'synthetic/repo',
          RUN_ID: '123',
          SHA: sha,
          RUN_URL: 'https://example.test/run',
          GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        },
      });
      expect(result.status, result.stderr).toBe(1);
      const comment = readFileSync(join(dir, 'comment'), 'utf8');
      const requests = readFileSync(join(dir, 'requests'), 'utf8');
      expect(requests).toContain(`repos/synthetic/repo/commits/${sha}/comments`);
      expect(comment).toContain('Run: https://example.test/run');
      expect(comment).toContain(
        scenario === 'lookup-failure'
          ? 'Failing lanes: `see the run`'
          : 'Failing lanes: `core lane, browser-2 lane`',
      );
      expect(result.stdout).toContain('::error::dev is red');
      expect(comment).toContain('pnpm test -- --browser-only --browser-shard=8/8');
      if (scenario === 'normal') {
        expect(comment).toContain(`Commits since the last green run (\`${green.slice(0, 10)}\`)`);
        expect(comment).toContain('fix: synthetic regression');
        expect(requests).not.toContain('compare/pr-green');
      } else {
        expect(comment).not.toContain('Commits since the last green run');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
