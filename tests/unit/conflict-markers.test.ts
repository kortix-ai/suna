import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findConflictMarkers } from '../src/core/conflict-markers';

// Built, never written literally: a literal marker in this file would make the
// repository scan below fail on the test that enforces it.
const OPEN = `${'<'.repeat(7)} HEAD`;
const CLOSE = `${'>'.repeat(7)} 6f52904b61`;
const MIDDLE = '='.repeat(7);
const BASE_LABELLED = `${'|'.repeat(7)} 88cb598b14`;
const BASE_BARE = '|'.repeat(7);

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('findConflictMarkers', () => {
  it('finds both ends of a committed conflict', () => {
    const content = ['# Register', OPEN, 'ours', MIDDLE, 'theirs', CLOSE, ''].join('\n');
    expect(findConflictMarkers(content)).toEqual([
      { line: 2, kind: 'open', text: OPEN },
      { line: 6, kind: 'close', text: CLOSE },
    ]);
  });

  it('does not flag a Setext heading, which underlines with the same character', () => {
    // This is why the middle marker cannot be part of the rule.
    expect(findConflictMarkers(['A learning', MIDDLE, '', 'Body.'].join('\n'))).toEqual([]);
  });

  it('does not flag prose that merely mentions the characters', () => {
    const prose = ['Resolve it, then delete the ' + OPEN.trim() + ' line.', 'a >>> b', '<<< c'];
    expect(findConflictMarkers(prose.join('\n'))).toEqual([]);
  });

  it('finds a diff3 BASE marker, labelled or bare', () => {
    // `merge.conflictStyle = diff3` writes a third section. A hand-resolution
    // that greps only for the two familiar markers leaves these behind, and
    // they are as invisible to CI as the conflict this file exists to catch —
    // 5 were already committed on `main` when this case was added.
    expect(findConflictMarkers([BASE_LABELLED, BASE_BARE].join('\n'))).toEqual([
      { line: 1, kind: 'base', text: BASE_LABELLED },
      { line: 2, kind: 'base', text: BASE_BARE },
    ]);
  });

  it('finds all three sections of a diff3 conflict', () => {
    const content = [OPEN, 'ours', BASE_LABELLED, 'base', MIDDLE, 'theirs', CLOSE].join('\n');
    expect(findConflictMarkers(content).map((m) => m.kind)).toEqual(['open', 'base', 'close']);
  });

  it('does not flag prose or a table that merely uses pipes', () => {
    const prose = ['| a | b |', '|---|---|', 'a || b', '|| c'];
    expect(findConflictMarkers(prose.join('\n'))).toEqual([]);
  });

  it('reports every marker in a file with more than one conflict', () => {
    const content = [OPEN, 'x', MIDDLE, 'y', CLOSE, OPEN, 'z', MIDDLE, 'w', CLOSE].join('\n');
    expect(findConflictMarkers(content).map((m) => m.line)).toEqual([1, 5, 6, 10]);
  });
});

describe('the repository', () => {
  // 30 s, not vitest's 5 s default: this reads every tracked file (~9,100 of
  // them, videos and wasm included). Measured on one laptop: 2.6 s with a warm
  // page cache, 9.1 s cold. A budget that flips with the disk cache is a false
  // red on a scan that must never be skipped.
  it('has no tracked file carrying an unresolved conflict marker', { timeout: 30_000 }, () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);

    // A repository this size must actually be enumerated. An empty or tiny
    // list would make this test pass while checking nothing.
    expect(tracked.length).toBeGreaterThan(1000);

    const offenders: string[] = [];
    for (const path of tracked) {
      let content: string;
      try {
        content = readFileSync(join(REPO_ROOT, path), 'utf8');
      } catch {
        continue; // deleted in the worktree, or not readable as text
      }
      if (content.includes('\0')) continue; // binary
      for (const marker of findConflictMarkers(content)) {
        offenders.push(`${path}:${marker.line} ${marker.text}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
