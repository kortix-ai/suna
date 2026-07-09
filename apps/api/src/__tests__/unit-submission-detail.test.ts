/**
 * Work-submission detail parsing — the structured `kind: output` payload
 * behind `kortix submit`. Pure logic only (keep-ref creation and the trace
 * queries are exercised by the ke2e review flow).
 */
import { describe, expect, test } from 'bun:test';
import {
  MAX_CLAIMS,
  MAX_INLINE_CONTENT_CHARS,
  MAX_SUBMISSION_FILES,
  normalizeSubmissionPath,
  parseOutputSubmissionDetail,
  submissionKeepRef,
} from '../projects/submission-detail';

const SHA = 'a'.repeat(40);

function gitDetail(overrides: Record<string, unknown> = {}) {
  return {
    submission_version: 1,
    storage: 'git',
    git: { commit_sha: SHA, files: [{ path: 'out/report.md', kind: 'markdown', bytes: 1234 }] },
    ...overrides,
  };
}

describe('submissionKeepRef', () => {
  test('namespaces under refs/kortix/submissions/', () => {
    expect(submissionKeepRef('abc-123')).toBe('refs/kortix/submissions/abc-123');
  });
});

describe('normalizeSubmissionPath', () => {
  test('accepts repo-relative paths and strips leading ./', () => {
    expect(normalizeSubmissionPath('out/report.md')).toBe('out/report.md');
    expect(normalizeSubmissionPath('./out/report.md')).toBe('out/report.md');
  });

  test('rejects traversal, absolute, flag-like and empty paths', () => {
    expect(normalizeSubmissionPath('../secrets.env')).toBeNull();
    expect(normalizeSubmissionPath('out/../../etc/passwd')).toBeNull();
    expect(normalizeSubmissionPath('/etc/passwd')).toBeNull();
    expect(normalizeSubmissionPath('--upload-pack=evil')).toBeNull();
    expect(normalizeSubmissionPath('')).toBeNull();
    expect(normalizeSubmissionPath('a//b')).toBeNull();
    expect(normalizeSubmissionPath(42)).toBeNull();
  });
});

describe('parseOutputSubmissionDetail', () => {
  test('legacy detail (no submission_version) passes through unstructured', () => {
    const result = parseOutputSubmissionDetail({ artifactLabel: 'Landing page', files: [{ path: 'x' }] });
    expect(result).toEqual({
      ok: true,
      structured: false,
      value: { artifactLabel: 'Landing page', files: [{ path: 'x' }] },
    });
  });

  test('rejects a self-reported trace even on legacy details', () => {
    const result = parseOutputSubmissionDetail({ trace: { audit: [] } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('server-assigned');
  });

  test('rejects unknown submission_version', () => {
    const result = parseOutputSubmissionDetail({ submission_version: 2, storage: 'inline', content: 'x' });
    expect(result.ok).toBe(false);
  });

  test('rejects missing/invalid storage', () => {
    expect(parseOutputSubmissionDetail({ submission_version: 1 }).ok).toBe(false);
    expect(parseOutputSubmissionDetail({ submission_version: 1, storage: 'blob' }).ok).toBe(false);
  });

  test('inline: requires non-empty content within the cap', () => {
    expect(parseOutputSubmissionDetail({ submission_version: 1, storage: 'inline' }).ok).toBe(false);
    expect(
      parseOutputSubmissionDetail({ submission_version: 1, storage: 'inline', content: '   ' }).ok,
    ).toBe(false);
    const over = 'x'.repeat(MAX_INLINE_CONTENT_CHARS + 1);
    expect(
      parseOutputSubmissionDetail({ submission_version: 1, storage: 'inline', content: over }).ok,
    ).toBe(false);

    const ok = parseOutputSubmissionDetail({
      submission_version: 1,
      storage: 'inline',
      content: 'All 4 checks passed.',
      artifact_kind: 'Report',
    });
    expect(ok).toEqual({
      ok: true,
      structured: true,
      value: {
        submission_version: 1,
        storage: 'inline',
        content: 'All 4 checks passed.',
        artifact_kind: 'report',
      },
    });
  });

  test('git: requires a full 40-char sha', () => {
    expect(parseOutputSubmissionDetail(gitDetail({ git: { commit_sha: 'abc123', files: [{ path: 'a.md' }] } })).ok).toBe(false);
    expect(parseOutputSubmissionDetail(gitDetail({ git: { files: [{ path: 'a.md' }] } })).ok).toBe(false);
  });

  test('git: requires non-empty, capped, deduped, safe file list', () => {
    expect(parseOutputSubmissionDetail(gitDetail({ git: { commit_sha: SHA, files: [] } })).ok).toBe(false);
    expect(
      parseOutputSubmissionDetail(
        gitDetail({ git: { commit_sha: SHA, files: [{ path: '../x' }] } }),
      ).ok,
    ).toBe(false);
    expect(
      parseOutputSubmissionDetail(
        gitDetail({ git: { commit_sha: SHA, files: [{ path: 'a.md' }, { path: 'a.md' }] } }),
      ).ok,
    ).toBe(false);
    const tooMany = Array.from({ length: MAX_SUBMISSION_FILES + 1 }, (_, i) => ({ path: `f-${i}.md` }));
    expect(
      parseOutputSubmissionDetail(gitDetail({ git: { commit_sha: SHA, files: tooMany } })).ok,
    ).toBe(false);
  });

  test('git: rejects a self-reported keep_ref', () => {
    const result = parseOutputSubmissionDetail(
      gitDetail({
        git: { commit_sha: SHA, keep_ref: 'refs/kortix/submissions/spoofed', files: [{ path: 'a.md' }] },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('keep_ref');
  });

  test('git: normalizes shas, paths and kinds', () => {
    const result = parseOutputSubmissionDetail(
      gitDetail({
        git: { commit_sha: SHA.toUpperCase(), branch: ' session/x ', files: [{ path: './out/a.md', kind: 'Markdown', bytes: 10.9 }] },
      }),
    );
    expect(result).toEqual({
      ok: true,
      structured: true,
      value: {
        submission_version: 1,
        storage: 'git',
        git: {
          commit_sha: SHA,
          branch: 'session/x',
          files: [{ path: 'out/a.md', kind: 'markdown', bytes: 10 }],
        },
      },
    });
  });

  test('claims: trimmed, capped, dropped when empty', () => {
    const withClaims = parseOutputSubmissionDetail(
      gitDetail({ claims: ['  numbers from live data  ', '', 'no PII included'] }),
    );
    expect(withClaims.ok).toBe(true);
    if (withClaims.ok && withClaims.structured) {
      expect(withClaims.value.claims).toEqual(['numbers from live data', 'no PII included']);
    }

    expect(parseOutputSubmissionDetail(gitDetail({ claims: 'not-an-array' })).ok).toBe(false);
    expect(parseOutputSubmissionDetail(gitDetail({ claims: [42] })).ok).toBe(false);
    const tooMany = Array.from({ length: MAX_CLAIMS + 1 }, (_, i) => `claim ${i}`);
    expect(parseOutputSubmissionDetail(gitDetail({ claims: tooMany })).ok).toBe(false);

    const emptied = parseOutputSubmissionDetail(gitDetail({ claims: ['', '  '] }));
    expect(emptied.ok).toBe(true);
    if (emptied.ok && emptied.structured) expect(emptied.value.claims).toBeUndefined();
  });
});
