import { describe, expect, test } from 'bun:test';

import {
  activityGroupLabel,
  emptyActivityCounts,
  humanizeShellCommand,
  humanizeShellStep,
} from './humanize';

describe('humanizeShellCommand', () => {
  test('sees past cd/env/sudo plumbing to the verb that matters', () => {
    // The exact shape that filled the transcript with unreadable rows.
    expect(
      humanizeShellCommand(
        'cd /workspace && SCRIPT=/workspace/.kortix/opencode/skills/presentations/present.py && python3 $SCRIPT build',
      ),
    ).toBe('Ran a script');
    expect(humanizeShellCommand('sudo rm -rf /tmp/build')).toBe('Deleted files');
    expect(humanizeShellCommand('NODE_ENV=production npm run build')).toBe('Ran a build step');
  });

  test('package managers read as dependencies, not as their binary name', () => {
    for (const cmd of ['npm install', 'pnpm add zod', 'bun i', 'pip install requests']) {
      expect(humanizeShellCommand(cmd)).toBe('Installed dependencies');
    }
  });

  test('tests beat the generic run rule', () => {
    expect(humanizeShellCommand('bun test')).toBe('Ran tests');
    expect(humanizeShellCommand('pnpm run test')).toBe('Ran tests');
    expect(humanizeShellCommand('pytest -q')).toBe('Ran tests');
  });

  test('file verbs', () => {
    expect(humanizeShellCommand('ls -la presentations/')).toBe('Looked at files');
    expect(humanizeShellCommand('cat README.md')).toBe('Read a file');
    expect(humanizeShellCommand('grep -rn "foo" src')).toBe('Searched the files');
    expect(humanizeShellCommand('mkdir -p out/slides')).toBe('Created a folder');
    expect(humanizeShellCommand('mv a.txt b.txt')).toBe('Moved files');
    expect(humanizeShellCommand('which bun')).toBe('Checked the setup');
    expect(humanizeShellCommand('pdftoppm -jpeg deck.pdf out')).toBe('Converted a file');
    expect(humanizeShellCommand('curl -s https://example.com')).toBe('Fetched from the web');
  });

  test('git subcommands get their own phrasing', () => {
    expect(humanizeShellCommand('git commit -m "x"')).toBe('Saved the changes');
    expect(humanizeShellCommand('git push origin main')).toBe('Pushed the changes');
    expect(humanizeShellCommand('git bisect start')).toBe('Used Git');
  });

  test('never returns empty — unknown commands still get a phrase', () => {
    expect(humanizeShellCommand('xyzzy --frobnicate')).toBe('Ran a command');
    expect(humanizeShellCommand('')).toBe('Ran a command');
    expect(humanizeShellCommand(undefined)).toBe('Ran a command');
  });
});

describe('humanizeShellStep', () => {
  test("the model's own description wins — it knows the intent", () => {
    expect(
      humanizeShellStep({
        description: 'Validate all slides',
        command: 'python3 present.py check',
      }),
    ).toBe('Validate all slides');
  });

  test('falls back to the command shape when there is no description', () => {
    expect(humanizeShellStep({ command: 'npm install' })).toBe('Installed dependencies');
    expect(humanizeShellStep({ description: '   ', command: 'ls' })).toBe('Looked at files');
  });

  test('a description that just echoes the command is not a description', () => {
    expect(humanizeShellStep({ description: 'ls -la', command: 'ls -la' })).toBe('Looked at files');
  });

  test('a runaway description falls back rather than blowing up the row', () => {
    expect(humanizeShellStep({ description: 'x'.repeat(200), command: 'npm install' })).toBe(
      'Installed dependencies',
    );
  });
});

describe('activityGroupLabel', () => {
  test('a homogeneous run keeps its specific verb — the verb is the information', () => {
    const counts = { ...emptyActivityCounts(), shell: 12 };
    expect(activityGroupLabel(counts, false)).toBe('Ran 12 commands');
    expect(activityGroupLabel(counts, true)).toBe('Running 12 commands');
    expect(activityGroupLabel({ ...emptyActivityCounts(), shell: 1 }, false)).toBe('Ran 1 command');
  });

  test('per-kind verbs', () => {
    expect(activityGroupLabel({ ...emptyActivityCounts(), read: 5 }, false)).toBe('Read 5 files');
    expect(activityGroupLabel({ ...emptyActivityCounts(), write: 1 }, false)).toBe('Wrote 1 file');
    expect(activityGroupLabel({ ...emptyActivityCounts(), edit: 3 }, true)).toBe('Editing 3 files');
    expect(activityGroupLabel({ ...emptyActivityCounts(), web: 2 }, false)).toBe(
      'Searched the web 2 times',
    );
  });

  test('a mixed run gets a count, not a lowest-common-denominator verb', () => {
    const counts = { ...emptyActivityCounts(), shell: 8, read: 4, write: 2 };
    expect(activityGroupLabel(counts, false)).toBe('14 steps');
    expect(activityGroupLabel(counts, true)).toBe('Working…');
  });

  test('an empty run says so rather than claiming zero steps', () => {
    expect(activityGroupLabel(emptyActivityCounts(), false)).toBe('No activity');
    expect(activityGroupLabel(emptyActivityCounts(), true)).toBe('Working…');
  });
});
