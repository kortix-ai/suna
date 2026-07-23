import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(
  import.meta.dir,
  '../../app/(app)/projects/[id]/sessions/[sessionId]/page.tsx',
);
const pageSource = readFileSync(PAGE_PATH, 'utf8');

describe('session page first-message hand-off', () => {
  test('the SDK start-stash replay is enabled (the ACP chat has no web-side pending-prompt sender)', () => {
    expect(pageSource).not.toContain('replayStartStash: false');
    expect(pageSource).toContain('replayStartStash: true');
  });

  test('the instant shell receives the session-bound agent so its picker locks', () => {
    const shellJsx = pageSource.slice(pageSource.indexOf('<InstantSessionShell'));
    const shellBlock = shellJsx.slice(0, shellJsx.indexOf('/>'));
    expect(shellBlock).toContain('boundAgentName={session.agentName}');
  });
});
