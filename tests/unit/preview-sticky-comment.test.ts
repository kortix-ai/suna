import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'scripts/ci/preview-sticky-comment.sh');

/**
 * Drives the REAL scripts/ci/preview-sticky-comment.sh with a stubbed `gh`.
 * The comment is the first place people look for the preview, so each case
 * asserts the exact title and lines one workflow state produces — and that no
 * state says "tested" unless the suite step itself succeeded.
 */
const GH_STUB = String.raw`#!/usr/bin/env bash
set -euo pipefail
method=GET
path=""
body=""
while [ $# -gt 0 ]; do
  case "$1" in
    api|--paginate) shift ;;
    -X) method="$2"; shift 2 ;;
    -f) body="$(printf '%s' "$2" | sed '1s/^body=//')"; shift 2 ;;
    *) path="$1"; shift ;;
  esac
done
if [ "$method" = GET ]; then
  cat "$STUB_DIR/comments.json"
  exit 0
fi
printf '%s %s\n' "$method" "$path" >>"$STUB_DIR/writes.log"
printf '%s\n' "$body" >"$STUB_DIR/body.md"
[ "$STUB_WRITE" = fail ] && { echo 'HTTP 502' >&2; exit 1; }
printf '{}\n'
`;

function run(env: Record<string, string>, options: { existing?: boolean; write?: 'ok' | 'fail' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preview-sticky-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'gh'), GH_STUB);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  writeFileSync(join(dir, 'writes.log'), '');
  writeFileSync(
    join(dir, 'comments.json'),
    JSON.stringify(options.existing ? [{ id: 5, body: 'x' }, { id: 42, body: '<!-- preview-status -->\nold' }] : [{ id: 5, body: 'x' }]),
  );
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      STUB_DIR: dir,
      STUB_WRITE: options.write ?? 'ok',
      GITHUB_REPOSITORY: 'kortix-ai/suna',
      NUM: '7763',
      COMMIT: 'a'.repeat(40),
      PREVIEW_URL: 'https://preview.example.test',
      REPORT_URL: '',
      PROVIDER: 'platinum',
      SANDBOX_ID: 'sbx-1',
      DEPLOY_OUTCOME: 'success',
      SUITE: '1',
      SUITE_OUTCOME: '',
      RUN_URL: 'https://github.com/kortix-ai/suna/actions/runs/9',
      ...env,
    },
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return { status: result.status, output: result.stdout + result.stderr, writes: read('writes.log').trim(), body: read('body.md') };
}

describe('preview-sticky-comment.sh', () => {
  it('publishes the origin while the suite is still running', () => {
    const r = run({});

    expect(r.status).toBe(0);
    expect(r.writes).toBe('POST repos/kortix-ai/suna/issues/7763/comments');
    expect(r.body.startsWith('<!-- preview-status -->\n## Preview environment - live; tests running\n')).toBe(true);
    expect(r.body).toContain('- **Preview:** https://preview.example.test');
    expect(r.body).toContain('- **Test report:** running');
    expect(r.body).toContain('https://github.com/kortix-ai/suna/actions/runs/9');
    expect(r.body).not.toContain('passed');
  });

  it('says "live and tested" only when the suite step succeeded', () => {
    const r = run({ SUITE_OUTCOME: 'success', REPORT_URL: 'https://preview.example.test/_tests/' }, { existing: true });

    expect(r.writes).toBe('PATCH repos/kortix-ai/suna/issues/comments/42');
    expect(r.body).toContain('## Preview environment - live and tested');
    expect(r.body).toContain('`pnpm test -- --target-full` passed.');
    expect(r.body).toContain('- **Test report:** https://preview.example.test/_tests/');
  });

  it('keeps the preview link when the suite fails', () => {
    const r = run({ SUITE_OUTCOME: 'failure', REPORT_URL: 'https://preview.example.test/_tests/' });

    expect(r.body).toContain('## Preview environment - live; tests failed');
    expect(r.body).toContain('- **Preview:** https://preview.example.test');
  });

  it('says NOT tested for a redeploy that skips the suite', () => {
    const r = run({ SUITE: '0' });

    expect(r.body).toContain('## Preview environment - live; NOT tested');
    expect(r.body).toContain('- **Test report:** not run for this commit');
    expect(r.body).not.toContain('passed.');
  });

  it('reports a failed deploy as a deployment failure, never as a test result', () => {
    const noUrl = run({ DEPLOY_OUTCOME: 'failure', PREVIEW_URL: '' });
    expect(noUrl.body).toContain('## Preview environment - deployment failed');
    expect(noUrl.body).toContain('- **Preview:** unavailable');

    const withUrl = run({ DEPLOY_OUTCOME: 'failure' });
    expect(withUrl.body).toContain('## Preview environment - deployment failed');
    expect(withUrl.body).not.toContain('tests failed');
  });

  it('says the suite did not finish when its step was cancelled', () => {
    const r = run({ SUITE_OUTCOME: 'cancelled' });

    expect(r.body).toContain('## Preview environment - live; tests did not finish');
  });

  it('never fails the job when GitHub rejects the comment', () => {
    const r = run({}, { write: 'fail' });

    expect(r.status).toBe(0);
    expect(r.output).toContain('::warning::');
  });
});
