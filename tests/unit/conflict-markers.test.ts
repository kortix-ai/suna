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

  it('reports every marker in a file with more than one conflict', () => {
    const content = [OPEN, 'x', MIDDLE, 'y', CLOSE, OPEN, 'z', MIDDLE, 'w', CLOSE].join('\n');
    expect(findConflictMarkers(content).map((m) => m.line)).toEqual([1, 5, 6, 10]);
  });
});

describe('the repository', () => {
  it('has no tracked file carrying an unresolved conflict marker', () => {
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
