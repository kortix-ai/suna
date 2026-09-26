import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The learnings skill is an append-only episodic ledger: one timestamped file
// per entry under entries/, indexed by a generated MEMORY.md. These checks keep
// the index honest and every entry well-formed, so recall by grep stays complete.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const LEDGER = join(REPO_ROOT, '.agents', 'skills', 'learnings');
const ENTRIES = join(LEDGER, 'entries');
const FILENAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

const entries = readdirSync(ENTRIES).filter((name) => name.endsWith('.md'));

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return {};
  return Object.fromEntries(
    match[1].split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
}

describe('the learnings ledger', () => {
  it('holds the entries split out of the old register, and every later one', () => {
    // 382 entries existed when the register became a ledger. Fewer means an
    // entry was deleted, which the append-only rule forbids.
    expect(entries.length).toBeGreaterThanOrEqual(382);
  });

  it('names every entry by its recorded UTC timestamp and a slug', () => {
    const offenders = entries.filter((name) => !FILENAME.test(name));
    expect(offenders).toEqual([]);
  });

  it('stamps each entry with the time in its filename, and gives it one title', () => {
    const offenders: string[] = [];
    for (const name of entries) {
      const text = readFileSync(join(ENTRIES, name), 'utf8');
      const meta = frontmatter(text);
      const [, day, hh, mm, ss] = name.match(FILENAME) ?? [];
      if (meta.recorded !== `${day}T${hh}:${mm}:${ss}Z`) offenders.push(`${name}: recorded ${meta.recorded}`);
      if (meta.incident_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(meta.incident_date)) {
        offenders.push(`${name}: incident_date ${meta.incident_date}`);
      }
      if (meta.supersedes !== undefined && !entries.includes(meta.supersedes)) {
        offenders.push(`${name}: supersedes a missing entry ${meta.supersedes}`);
      }
      const titles = text.split('\n').filter((line) => line.startsWith('# '));
      if (titles.length !== 1) offenders.push(`${name}: ${titles.length} '# ' titles`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps MEMORY.md equal to what scripts/index.sh generates', () => {
    let failure = '';
    try {
      execFileSync('bash', [join(LEDGER, 'scripts', 'index.sh'), '--check'], { stdio: 'pipe' });
    } catch (error) {
      failure = String((error as { stderr?: Buffer }).stderr ?? error);
    }
    expect(failure).toBe('');
  });
});
