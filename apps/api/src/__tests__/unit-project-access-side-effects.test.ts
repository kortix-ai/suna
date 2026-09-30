import { describe, expect, it } from 'bun:test';

// The project authorization path lives in project-access.ts since the access.ts
// split (KRTX-301); the barrel re-exports it, so the pin reads the owner.
const accessSource = await Bun.file(
  new URL('../projects/lib/project-access.ts', import.meta.url),
).text();

describe('project authorization side effects', () => {
  it('does not resume a sandbox during generic project authorization', () => {
    expect(accessSource).not.toContain('preResumeRecentStoppedSessions');
    expect(accessSource).not.toContain('KORTIX_PRERESUME');
  });
});
