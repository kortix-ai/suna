import { describe, expect, mock, test } from 'bun:test';
import type { GitBackedProject } from './types';

// Characterization tests for the shared diff parser and the one rev-parse
// helper. The parse tests pin byte-for-byte git output shapes; the helper
// tests pin the thrown message and each caller's null/throw mapping with a
// scripted runGit, because a real `rev-parse --verify` never prints a
// non-hex answer (it fails with a git error instead).

type RunGitResult = { stdout: string; stderr: string };

const runGitCalls: string[][] = [];
const refreshCalls: unknown[] = [];
let runGitImpl: (args: string[]) => Promise<RunGitResult> = async () => ({
  stdout: '',
  stderr: '',
});
let scaffoldTreeImpl: () => Promise<string> = async () => 'b'.repeat(40);

const realMirror = await import('./mirror');
mock.module('./mirror', () => ({
  ...realMirror,
  refreshMirror: async (project: unknown, force?: unknown) => {
    refreshCalls.push({ project, force });
    return '/scripted/mirror';
  },
  runGit: (args: string[]) => {
    runGitCalls.push(args);
    return runGitImpl(args);
  },
}));
const realScaffoldIdentity = await import('./scaffold-identity');
mock.module('./scaffold-identity', () => ({
  ...realScaffoldIdentity,
  scaffoldTreeSha: () => scaffoldTreeImpl(),
}));

const {
  parseGitFileChanges,
  resolveBranchTip,
  resolveCommitSha,
  resolveCommitShaAt,
  UnexpectedRevParseOutputError,
} = await import('./commits');
const { resolveFastBootGitHint, resolveScaffoldDeltaBoundary } = await import('./fast-boot-bundle');

const project: GitBackedProject = {
  projectId: 'proj_unit-test',
  repoUrl: 'https://git.example.test/unit-test.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

function script(...results: (RunGitResult | Error)[]) {
  const queue = [...results];
  runGitImpl = async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('scripted runGit ran dry');
    if (next instanceof Error) throw next;
    return next;
  };
}

describe('parseGitFileChanges', () => {
  test('parses plain A/M/D status pairs and assigns the numstat counts', () => {
    const nameStatus = 'A\0added.txt\0M\0changed.txt\0D\0deleted.txt\0';
    const numstat = ['3\t1\tchanged.txt', '10\t0\tadded.txt', '0\t4\tdeleted.txt', ''].join('\n');
    const { files, additions, deletions } = parseGitFileChanges(nameStatus, numstat);
    expect(files).toEqual([
      { path: 'added.txt', old_path: null, status: 'added', additions: 10, deletions: 0 },
      { path: 'changed.txt', old_path: null, status: 'modified', additions: 3, deletions: 1 },
      { path: 'deleted.txt', old_path: null, status: 'deleted', additions: 0, deletions: 4 },
    ]);
    expect(additions).toBe(13);
    expect(deletions).toBe(5);
  });

  test('parses R/C NUL pairs with old_path and rewrites the numstat brace path', () => {
    const nameStatus = 'R100\0docs/old.md\0docs/new.md\0C100\0src.txt\0dst.txt\0';
    const numstat = ['3\t1\tdocs/{old.md => new.md}', '5\t2\tsrc.txt => dst.txt', ''].join('\n');
    const { files, additions, deletions } = parseGitFileChanges(nameStatus, numstat);
    // The brace form is the one git prints for a same-directory rename; it
    // must land on the destination the name-status pass keyed.
    expect(files[0]).toEqual({
      path: 'docs/new.md',
      old_path: 'docs/old.md',
      status: 'renamed',
      additions: 3,
      deletions: 1,
    });
    // `a => b` without braces does not match the name-status destination: the
    // counts ride the totals and no file entry gains them.
    expect(files[1]).toEqual({
      path: 'dst.txt',
      old_path: 'src.txt',
      status: 'copied',
      additions: 0,
      deletions: 0,
    });
    expect(additions).toBe(8);
    expect(deletions).toBe(3);
  });

  test('counts a binary "-" numstat line as zero', () => {
    const { files, additions, deletions } = parseGitFileChanges('A\0blob.bin\0', '-\t-\tblob.bin\n');
    expect(files).toEqual([
      { path: 'blob.bin', old_path: null, status: 'added', additions: 0, deletions: 0 },
    ]);
    expect(additions).toBe(0);
    expect(deletions).toBe(0);
  });

  test('counts a typechange status and numstat lines with no status entry', () => {
    const nameStatus = 'T\0link.dat\0';
    const numstat = ['2\t2\tlink.dat', '9\t9\tonly-in-numstat.txt', ''].join('\n');
    const { files, additions, deletions } = parseGitFileChanges(nameStatus, numstat);
    expect(files).toEqual([
      { path: 'link.dat', old_path: null, status: 'typechange', additions: 2, deletions: 2 },
    ]);
    expect(additions).toBe(11);
    expect(deletions).toBe(11);
  });

  test('returns empty totals and no files for empty diff output', () => {
    expect(parseGitFileChanges('', '')).toEqual({ files: [], additions: 0, deletions: 0 });
  });

  test('stops at a dangling rename token instead of looping', () => {
    // Defensive branch: git never truncates the pair, but a malformed answer
    // must terminate the scan rather than index past it.
    expect(parseGitFileChanges('R100\0only-old\0', '').files).toEqual([]);
  });
});

describe('resolveCommitShaAt', () => {
  test('returns the resolved SHA and asks for the commit peel', async () => {
    script({ stdout: `${'a'.repeat(40)}\n`, stderr: '' });
    await expect(resolveCommitShaAt('/repo', 'main')).resolves.toBe('a'.repeat(40));
    expect(runGitCalls.at(-1)).toEqual(['rev-parse', '--verify', 'main^{commit}']);
  });

  test('throws the pinned message when rev-parse answers without a 40-hex sha', async () => {
    script({ stdout: 'not-a-sha\n', stderr: '' });
    const error: unknown = await resolveCommitShaAt('/repo', 'main').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnexpectedRevParseOutputError);
    expect(
      error instanceof UnexpectedRevParseOutputError && error.message,
    ).toBe('Unexpected git rev-parse output for main: not-a-sha');
  });

  test('propagates a git command failure untouched, never as the hex message', async () => {
    script(new Error('fatal: Needed a single revision'));
    await expect(resolveCommitShaAt('/repo', 'main')).rejects.toThrow(
      'fatal: Needed a single revision',
    );
  });
});

describe('project-level wrappers keep their own mapping', () => {
  test('resolveCommitSha still refreshes the mirror first', async () => {
    script({ stdout: `${'c'.repeat(40)}\n`, stderr: '' });
    await expect(resolveCommitSha(project, 'dev')).resolves.toBe('c'.repeat(40));
    expect(refreshCalls.at(-1)).toEqual({ project, force: undefined });
    expect(runGitCalls.at(-1)).toEqual(['rev-parse', '--verify', 'dev^{commit}']);
  });

  test('resolveBranchTip keeps the fully qualified refs/heads form', async () => {
    script({ stdout: `${'d'.repeat(40)}\n`, stderr: '' });
    await expect(resolveBranchTip(project, 'feature-x')).resolves.toBe('d'.repeat(40));
    expect(runGitCalls.at(-1)).toEqual(['rev-parse', '--verify', 'refs/heads/feature-x^{commit}']);
  });
});

describe('fast-boot callers map the shared helper', () => {
  test('resolveScaffoldDeltaBoundary maps the hex failure to null', async () => {
    script({ stdout: 'garbage\n', stderr: '' });
    await expect(resolveScaffoldDeltaBoundary('/repo', 'main')).resolves.toBeNull();
  });

  test('resolveScaffoldDeltaBoundary rethrows a real git failure', async () => {
    script(new Error('fatal: Needed a single revision'));
    await expect(resolveScaffoldDeltaBoundary('/repo', 'main')).rejects.toThrow(
      'fatal: Needed a single revision',
    );
  });

  test('resolveFastBootGitHint rethrows the hex failure for the base tip', async () => {
    script({ stdout: 'garbage\n', stderr: '' });
    await expect(resolveFastBootGitHint(project, 'main')).rejects.toThrow(
      'Unexpected git rev-parse output for main: garbage',
    );
  });

  test('resolveFastBootGitHint swallows a delta-build git failure into a bare hint', async () => {
    script({ stdout: `${'a'.repeat(40)}\n`, stderr: '' }, new Error('fatal: bad object'));
    await expect(resolveFastBootGitHint(project, 'main')).resolves.toEqual({
      baseSha: 'a'.repeat(40),
    });
  });

  test('resolveFastBootGitHint skips the delta when the starter tree is unavailable', async () => {
    script({ stdout: `${'a'.repeat(40)}\n`, stderr: '' });
    scaffoldTreeImpl = async () => {
      throw new Error('starter tree unavailable');
    };
    await expect(resolveFastBootGitHint(project, 'main')).resolves.toEqual({
      baseSha: 'a'.repeat(40),
    });
    scaffoldTreeImpl = async () => 'b'.repeat(40);
  });
});
