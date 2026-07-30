import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { resolveEndUserRef } from './end-user-ref';

/**
 * The documented status code for END_USER_REF_CONFLICT drifted from the code and
 * nobody noticed until an audit read both: create returns 400, and two docs said
 * 409. Someone integrating against the published table writes
 * `if (status === 409)` and their retry logic never fires.
 *
 * Docs are the product surface for a backend platform, so the contract is pinned
 * here rather than left to review.
 */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
const DOCS = [
  join(REPO_ROOT, 'docs', 'KORTIX_AS_A_BACKEND_GUIDE.md'),
  join(REPO_ROOT, 'apps', 'web', 'content', 'docs', 'backend.mdx'),
];

describe('END_USER_REF_CONFLICT — the documented contract matches the code', () => {
  test('a disagreeing pair is refused, and the code is the documented one', () => {
    const result = resolveEndUserRef({ end_user_ref: 'alice', origin_ref: 'bob' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('END_USER_REF_CONFLICT');
  });

  test('agreeing values are NOT a conflict — a client mid-migration sends both', () => {
    expect(resolveEndUserRef({ end_user_ref: 'alice', origin_ref: 'alice' }).ok).toBe(true);
  });

  test('no doc pairs this code with a status other than 400', () => {
    // The create path returns 400 (lib/sessions.ts) and so does the list filter
    // (routes/r7.ts). Any other status next to this code in a doc is a lie a
    // reader would code against.
    for (const path of DOCS) {
      const text = readFexistsOrEmpty(path);
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line.includes('END_USER_REF_CONFLICT')) continue;
        const statuses = [...line.matchAll(/`(\d{3})`|\b(4\d{2})\s+END_USER_REF_CONFLICT/g)]
          .map((m) => m[1] ?? m[2])
          .filter(Boolean);
        for (const status of statuses) {
          expect({ path, line: line.trim().slice(0, 120), status }).toMatchObject({
            status: '400',
          });
        }
      }
    }
  });
});

/** A missing doc should not fail the suite — the point is catching a WRONG one. */
function readFexistsOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
