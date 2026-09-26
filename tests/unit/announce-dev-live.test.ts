import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'scripts/ci/announce-dev-live.sh');

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

/**
 * Drives the REAL scripts/ci/announce-dev-live.sh with stubbed `gh` and `curl`
 * executables placed first on PATH. The stubs answer from JSON fixtures in the
 * temp directory and log every write, so each case asserts the exact comment a
 * pull request receives.
 */
const GH_STUB = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$STUB_DIR/gh.log"
path=""
method=GET
body=""
while [ $# -gt 0 ]; do
  case "$1" in
    api|--paginate) shift ;;
    -X) method="$2"; shift 2 ;;
    -f) body="$(printf '%s' "$2" | sed '1s/^body=//')"; shift 2 ;;
    *) path="$1"; shift ;;
  esac
done
if [ "$method" != GET ]; then
  printf '%s %s\n' "$method" "$path" >>"$STUB_DIR/writes.log"
  printf '%s\n' "$body" >"$STUB_DIR/body-$(printf '%s' "$path" | tr '/' '_').md"
  [ "$STUB_WRITE" = fail ] && { echo 'HTTP 403: Resource not accessible by integration' >&2; exit 1; }
  printf '{}\n'
  exit 0
fi
file="$STUB_DIR/gh/$(printf '%s' "$path" | tr '/' '_').json"
[ -f "$file" ] || { echo "stub gh: unhandled GET $path" >&2; exit 64; }
cat "$file"
`;

const CURL_STUB = String.raw`#!/usr/bin/env bash
set -euo pipefail
for url; do :; done
case "$url" in
  https://dev-api.kortix.com/v1/health) cat "$STUB_DIR/health-api.json" ;;
  https://dev.kortix.com/api/health) cat "$STUB_DIR/health-web.json" ;;
  https://gateway-dev.kortix.com/health/live) cat "$STUB_DIR/health-gateway.json" ;;
  *) echo "stub curl: unhandled $url" >&2; exit 22 ;;
esac
`;

interface Fixture {
  env?: Record<string, string>;
  /** commit sha → merged pull request number (absent = direct push). */
  pulls?: Record<string, number>;
  compare?: string[];
  existingComment?: { pr: number; id: number };
  health?: { api?: string; web?: string; gateway?: string };
  write?: 'ok' | 'fail';
}

function run(fixture: Fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'announce-dev-live-'));
  const gh = join(dir, 'gh');
  const fixtures = join(dir, 'gh');
  writeFileSync(join(dir, 'gh.log'), '');
  writeFileSync(join(dir, 'writes.log'), '');
  spawnSync('mkdir', ['-p', join(dir, 'bin'), fixtures]);
  writeFileSync(join(dir, 'bin', 'gh'), GH_STUB);
  writeFileSync(join(dir, 'bin', 'curl'), CURL_STUB);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  chmodSync(join(dir, 'bin', 'curl'), 0o755);
  const put = (path: string, value: unknown) =>
    writeFileSync(join(fixtures, `${path.replaceAll('/', '_')}.json`), JSON.stringify(value));

  put(`repos/kortix-ai/suna/compare/${BASE}...${SHA}`, {
    commits: (fixture.compare ?? [SHA]).map((sha) => ({ sha })),
  });
  for (const sha of [SHA, BASE, OTHER]) {
    const number = fixture.pulls?.[sha];
    put(
      `repos/kortix-ai/suna/commits/${sha}/pulls`,
      number ? [{ number, merged_at: '2026-09-26T17:00:00Z', base: { ref: 'main' } }] : [],
    );
    if (number) {
      put(`repos/kortix-ai/suna/pulls/${number}`, { number, merged_at: '2026-09-26T17:00:00Z' });
      put(
        `repos/kortix-ai/suna/issues/${number}/comments`,
        fixture.existingComment?.pr === number
          ? [{ id: 11, body: 'unrelated' }, { id: fixture.existingComment.id, body: '<!-- dev-live -->\nold' }]
          : [{ id: 11, body: 'unrelated' }],
      );
    }
  }
  const health = { api: SHA, web: SHA, gateway: SHA, ...fixture.health };
  writeFileSync(join(dir, 'health-api.json'), JSON.stringify({ status: 'ok', commit: health.api }));
  writeFileSync(join(dir, 'health-web.json'), JSON.stringify({ status: 'ok', commit: health.web }));
  writeFileSync(join(dir, 'health-gateway.json'), JSON.stringify({ commit: health.gateway }));

  const result = spawnSync('bash', [script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      STUB_DIR: dir,
      STUB_WRITE: fixture.write ?? 'ok',
      GITHUB_REPOSITORY: 'kortix-ai/suna',
      SHA,
      BASE,
      RUN_URL: 'https://github.com/kortix-ai/suna/actions/runs/1',
      API_RESULT: 'success',
      GATEWAY_RESULT: 'unchanged',
      WEB_RESULT: 'success',
      // 17:06:12 UTC: 6 m 12 s after the fixture's merged_at.
      NOW_EPOCH: String(Date.parse('2026-09-26T17:06:12Z') / 1000),
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
      ...fixture.env,
    },
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    writes: read('writes.log').split('\n').filter(Boolean),
    body: (path: string) => read(`body-${path.replaceAll('/', '_')}.md`),
    summary: read('summary.md'),
  };
}

describe('announce-dev-live.sh', () => {
  it('posts "Live on dev" with the verified commit and lead time on every pull request the deploy shipped', () => {
    const r = run({ compare: [OTHER, SHA], pulls: { [OTHER]: 7750, [SHA]: 7751 } });

    expect(r.stderr).not.toContain('unhandled');
    expect(r.status).toBe(0);
    expect(r.writes).toEqual([
      'POST repos/kortix-ai/suna/issues/7750/comments',
      'POST repos/kortix-ai/suna/issues/7751/comments',
    ]);
    const body = r.body('repos/kortix-ai/suna/issues/7751/comments');
    expect(body.startsWith('<!-- dev-live -->\n')).toBe(true);
    expect(body).toContain('### Live on dev — 6m 12s after merge');
    expect(body).toContain('| API · dev-api.kortix.com | serving `aaaaaaaaaa` |');
    expect(body).toContain('| Web · dev.kortix.com | serving `aaaaaaaaaa` |');
    expect(body).not.toContain('gateway');
    expect(body).toContain('Shipped together with #7750.');
    expect(body).toContain('https://github.com/kortix-ai/suna/actions/runs/1');
    expect(r.summary).toContain('#7750');
  });

  it('edits its own earlier comment instead of adding a second one', () => {
    const r = run({ pulls: { [SHA]: 7751 }, existingComment: { pr: 7751, id: 99 } });

    expect(r.status).toBe(0);
    expect(r.writes).toEqual(['PATCH repos/kortix-ai/suna/issues/comments/99']);
    expect(r.body('repos/kortix-ai/suna/issues/comments/99')).toContain('### Live on dev');
  });

  it('says "Not live on dev yet" and names the surface when a deploy failed', () => {
    const r = run({ pulls: { [SHA]: 7751 }, env: { WEB_RESULT: 'failure' } });

    expect(r.status).toBe(0);
    const body = r.body('repos/kortix-ai/suna/issues/7751/comments');
    expect(body).toContain('### Not live on dev yet');
    expect(body).toContain('| Web · dev.kortix.com | deploy failure |');
    expect(body).toContain('The next deploy from `main` retries');
  });

  it('never claims live when /health reports another commit', () => {
    const r = run({ pulls: { [SHA]: 7751 }, health: { api: OTHER } });

    const body = r.body('repos/kortix-ai/suna/issues/7751/comments');
    expect(body).toContain('### Not live on dev yet');
    expect(body).toContain('| API · dev-api.kortix.com | deployed; `/health` reports `cccccccccc` |');
  });

  it('announces only the head commit when the deploy base is unknown', () => {
    const r = run({ pulls: { [SHA]: 7751, [OTHER]: 7750 }, env: { BASE: '' } });

    expect(r.writes).toEqual(['POST repos/kortix-ai/suna/issues/7751/comments']);
  });

  it('comments on nothing for a direct push without a pull request', () => {
    const r = run({ pulls: {} });

    expect(r.status).toBe(0);
    expect(r.writes).toEqual([]);
  });

  it('never fails the deploy run when GitHub rejects the comment', () => {
    const r = run({ pulls: { [SHA]: 7751 }, write: 'fail' });

    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain('::warning::');
  });

  it('is wired as the last Deploy Dev job with pull-request write access only', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/deploy-dev.yml'), 'utf8');
    const start = workflow.indexOf('\n  announce-live:\n');
    expect(start).toBeGreaterThan(0);
    const job = workflow.slice(start);

    expect(job).toContain('bash scripts/ci/announce-dev-live.sh');
    expect(job).toContain('pull-requests: write');
    expect(job).not.toContain('contents: write');
    for (const need of ['deploy-api-ecs', 'verify-gateway-dev-parity', 'verify-web-dev']) {
      expect(job).toContain(need);
    }
  });
});
