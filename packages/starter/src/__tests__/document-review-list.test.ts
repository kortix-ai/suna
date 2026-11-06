import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(
  import.meta.dir,
  '../../templates/marketplace/skills/document-review/scripts/manage_state.py',
);

for (const command of ['get-claims', 'get-issues']) {
  for (const flags of [
    [],
    ['--section', 'Intro'],
    ['--section', 'Absent'],
    [
      command === 'get-claims' ? '--status' : '--severity',
      command === 'get-claims' ? 'verified' : 'high',
    ],
    [
      command === 'get-claims' ? '--status' : '--severity',
      command === 'get-claims' ? 'refuted' : 'low',
      '--section',
      'Intro',
    ],
  ]) {
    for (const empty of [false, true]) {
      test(`${command} ${flags.join(' ')} empty=${empty}`, () => {
        const cwd = mkdtempSync(join(tmpdir(), 'document-review-'));
        const common = {
          section: 'Intro',
          location: 'p1',
          original_text: 'Synthetic text',
          description: 'Synthetic description',
        };
        const state = {
          phase: 'complete',
          claims: empty
            ? {}
            : {
                c1: {
                  ...common,
                  claim_id: 'c1',
                  claim_status: 'verified',
                  claim_type: 'verify_public_data',
                  anchor: 'a1',
                  source_urls: ['https://example.test/a', 'https://example.test/b'],
                },
                c2: {
                  ...common,
                  section: 'Body',
                  claim_id: 'c2',
                  claim_status: 'refuted',
                  claim_type: 'numerical_consistency',
                },
              },
          issues: empty
            ? {}
            : {
                i1: {
                  ...common,
                  issue_id: 'i1',
                  severity: 'high',
                  issue_type: 'narrative_logic',
                  anchor: 'a2',
                  text_context: 'Context',
                  new_text: 'Replacement',
                },
                i2: {
                  ...common,
                  section: 'Body',
                  issue_id: 'i2',
                  severity: 'low',
                  issue_type: 'spelling_grammar',
                  text_context: '',
                  new_text: '',
                },
              },
        };
        try {
          const original = JSON.stringify(state);
          writeFileSync(join(cwd, 'document_review_state.json'), original);
          const result = spawnSync('python3', [script, command, ...flags], {
            cwd,
            encoding: 'utf8',
          });
          expect(result.status).toBe(0);
          expect(result.stderr).toBe('');
          expect(result.stdout).toMatchSnapshot();
          const audit = JSON.parse(readFileSync(join(cwd, 'review_log.jsonl'), 'utf8'));
          expect(Number.isNaN(Date.parse(audit.timestamp))).toBe(false);
          delete audit.timestamp;
          expect(audit).toMatchSnapshot();
          expect(readFileSync(join(cwd, 'document_review_state.json'), 'utf8')).toBe(original);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      });
    }
  }
}

test('list-valued description/new_text print as the raw list, not joined', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'document-review-'));
  const common = { section: 'Intro', location: 'p1', original_text: 'T' };
  const state = {
    phase: 'complete',
    claims: {
      c1: {
        ...common,
        claim_id: 'c1',
        claim_status: 'verified',
        claim_type: 'verify_public_data',
        description: ['d1', 2],
      },
    },
    issues: {
      i1: {
        ...common,
        issue_id: 'i1',
        severity: 'high',
        issue_type: 'narrative_logic',
        text_context: 'C',
        description: ['d1', 2],
        new_text: ['a', 3],
      },
    },
  };
  try {
    writeFileSync(join(cwd, 'document_review_state.json'), JSON.stringify(state));
    const claims = spawnSync('python3', [script, 'get-claims'], { cwd, encoding: 'utf8' });
    const issues = spawnSync('python3', [script, 'get-issues'], { cwd, encoding: 'utf8' });
    expect(claims.status).toBe(0);
    expect(claims.stdout).toContain("  Description: ['d1', 2]");
    expect(issues.status).toBe(0);
    expect(issues.stdout).toContain("  Description: ['d1', 2]");
    expect(issues.stdout).toContain("  Suggested: ['a', 3]");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a record missing a required field fails with a KeyError, exit 1', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'document-review-'));
  const state = {
    phase: 'complete',
    claims: {
      c1: {
        section: 'Intro',
        location: 'p1',
        original_text: 'T',
        claim_id: 'c1',
        claim_status: 'verified',
        claim_type: 'verify_public_data',
      },
    },
    issues: {},
  };
  try {
    writeFileSync(join(cwd, 'document_review_state.json'), JSON.stringify(state));
    const claims = spawnSync('python3', [script, 'get-claims'], { cwd, encoding: 'utf8' });
    expect(claims.status).toBe(1);
    expect(claims.stderr).toContain("KeyError: 'description'");
    expect(claims.stdout).not.toContain('Description: None');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
