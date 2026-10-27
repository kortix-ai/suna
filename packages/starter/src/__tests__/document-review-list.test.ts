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
