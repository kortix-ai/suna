import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeResults } from '../src/core/report';
import type { RunResult } from '../src/core/result';
import { GUARD_PATTERN_SOURCE, scrubSecretShapes, scrubValue } from '../src/core/scrub';

// The CI guard ("Guard test artifacts against secrets") greps results.json and
// report.html for these shapes before upload. It was a silent no-op from its
// first run until 2026-08-25: it invoked `rg`, which GitHub's ubuntu images do
// not ship, under `2>/dev/null`. The first Blacksmith run (whose image has rg)
// found kortix_pat_/kortix_sa_/setup-link tokens in every uploaded artifact.
// These tests pin (1) the runner scrubs the same shapes it will be judged by,
// (2) the guard uses grep, present on every runner image.

const guard = new RegExp(GUARD_PATTERN_SOURCE);

// Synthetic values in the exact shapes found in run 32905168237's artifact.
const PAT = `kortix_pat_${'yY5MkM1z2DqkK'.repeat(3)}`;
const SA = `kortix_sa_${'Cu74jk1OrLkE3F'.repeat(3)}`;
const SK = `sk-${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`;
const JWT = `eyJ${'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'.repeat(2)}.eyJzdWIiOiIxIn0.sig_abc`;
// base64url JSON with no `.` — the setup-link/app token shape the guard's
// JWT-style anchor would let through, still a credential.
const BLOB = `eyJ${'hY2NvdW50SWQiOiI0NWZhMTIzNC01Njc4'.repeat(3)}`;

describe('scrubSecretShapes', () => {
  it.each([
    ['PAT', PAT],
    ['service-account token', SA],
    ['sk- key', SK],
    ['JWT', JWT],
    ['base64url JSON blob', BLOB],
  ])('masks a %s so the guard pattern no longer matches', (_label, token) => {
    const text = `prefix "secret_key": "${token}" suffix`;
    // The guard's JWT anchor (`eyJ…\.`) does not see the dot-less blob; the
    // scrubber still must.
    if (token !== BLOB) expect(text).toMatch(guard);
    const scrubbed = scrubSecretShapes(text);
    expect(scrubbed).not.toMatch(guard);
    expect(scrubbed).not.toContain(token);
    // Same visual shape as client.ts mask(): 6-char head + ***[len].
    expect(scrubbed).toContain(`${token.slice(0, 6)}***[${token.length}]`);
  });

  it('leaves ordinary text and short lookalikes alone', () => {
    const text = 'kortix_pat_short sk-abc eyJ.x plain words 2026-08-25';
    expect(scrubSecretShapes(text)).toBe(text);
  });
});

describe('scrubValue', () => {
  it('walks nested objects, arrays and keys without touching non-strings', () => {
    const input = {
      n: 42,
      ok: true,
      none: null,
      stdout: `token: ${PAT}\n`,
      list: [SK, { deep: [JWT] }],
      [`k_${SA}`]: 'v',
    };
    const out = scrubValue(input);
    expect(out.n).toBe(42);
    expect(out.ok).toBe(true);
    expect(out.none).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(guard);
    for (const t of [PAT, SK, JWT, SA]) expect(JSON.stringify(out)).not.toContain(t);
    // A fresh tree: the caller's object is not mutated.
    expect(input.stdout).toContain(PAT);
  });
});

describe('writeResults', () => {
  it('writes results.json and report.html that pass the CI guard', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'ke2e-scrub-'));
    const result = {
      target: 'local',
      apiUrl: 'http://localhost:8008/v1',
      flows: [
        {
          id: 'TOK-1',
          domain: 'tokens',
          status: 'pass',
          durationMs: 1,
          steps: [
            {
              name: 'create a PAT',
              status: 'pass',
              durationMs: 1,
              captured: [
                {
                  req: { method: 'POST', url: 'http://x/v1/tokens', headers: {} },
                  res: { status: 200, headers: {}, bodyText: `{"secret_key":"${PAT}"}` },
                },
              ],
              assertions: [
                { kind: 'body.exists', description: 'body $.secret_key exists', pass: true, actual: PAT },
              ],
            },
          ],
        },
      ],
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, durationMs: 1 },
    } as unknown as RunResult;
    const jsonPath = resolve(dir, 'results.json');
    const htmlPath = resolve(dir, 'report.html');
    writeResults(result, jsonPath, htmlPath);
    for (const p of [jsonPath, htmlPath]) {
      const text = readFileSync(p, 'utf8');
      expect(text, p).not.toMatch(guard);
      expect(text, p).not.toContain(PAT);
      expect(text, p).toContain(`kortix***[${PAT.length}]`);
    }
  });
});

describe('the artifact guard step', () => {
  const workflows = ['tests.yml', 'tests-browser-nightly.yml', 'tests-release.yml'];

  it.each(workflows)('%s greps with the runner-scrubbed pattern and never calls rg', (name) => {
    const source = readFileSync(resolve(import.meta.dirname, `../../.github/workflows/${name}`), 'utf8');
    const guards = source.split('Guard test artifacts against secrets').length - 1;
    expect(guards, 'guard step present').toBeGreaterThan(0);
    expect(source.split(`pattern='${GUARD_PATTERN_SOURCE}'`).length - 1).toBe(guards);
    expect(source.split('grep -rEIl "$pattern" tests/test-results').length - 1).toBe(guards);
    expect(source).not.toMatch(/\brg -l\b/);
  });
});
