import { gitOrEmpty } from '../src/fixtures/git-or-empty';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from '../src/fixtures/repo';

// Fake timers are process-wide in bun: `bun test --isolate` gives each file a
// fresh global object, not a fresh clock. A file that fakes timers and never
// restores them hangs the next file in the same worker that waits on a real
// timer. On 2026-10-07 that stalled the whole apps/web suite at 0% CPU and
// failed every branch's packages lane (learnings ledger, same date).

describe('fake timers', () => {
  it('every test file that fakes timers also restores real timers', () => {
    const offenders = gitOrEmpty(['grep', '-l', 'useFakeTimers(', '--', '*.test.ts', '*.test.tsx']).filter(
      (file) => !readRepoFile(file).includes('useRealTimers('),
    );
    expect(offenders).toEqual([]);
  });
});
