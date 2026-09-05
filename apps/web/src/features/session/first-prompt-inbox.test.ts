import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The first prompt of a new session is a DURABLE ROW, from every producer.
 *
 * It used to travel client-side — stashed in sessionStorage, replayed by the
 * workbench once the runtime answered, a 19-25s window (measured boot) in
 * which a closed tab, a crash, or a navigation lost the message silently.
 * Now every producer either hands it to the create itself
 * (`create.pending_prompt`, converted into a `session_lifecycle_commands` row
 * inside the create transaction) or POSTs it (`startSessionWithPrompt`), and
 * the stash carries ONLY the picks.
 *
 * Source assertions, same rationale as `session-chat-working-projection.test.ts`:
 * these are page-level components with no DOM harness, and the wiring under
 * test is which channel each producer hands the prompt to.
 */
function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const shell = read('./instant-session-shell.tsx');
// The composer send moved out of the page and into a hook when the subproject
// page grew a SECOND `ProjectHome` (2026-09-04): both surfaces now share one
// producer, so this tripwire follows it there and covers both at once.
const projectHomeSend = read('../workspace/project-layout/use-project-home-send.ts');
const projectHomePage = read('../../app/(app)/projects/[id]/page.tsx');
const subprojectPage = read('../subprojects/subproject-page.tsx');
const sessionPage = read('../../app/(app)/projects/[id]/sessions/[sessionId]/page.tsx');
const configureThread = read('../workspace/customize/use-configure-thread.ts');
const runUpgrade = read('../workspace/customize/migrate-to-v2/use-run-upgrade.ts');

describe('every first-prompt producer writes a durable row, not a prompt stash', () => {
  test('instant shell POSTs via startSessionWithPrompt with data-URL attachments', () => {
    expect(shell).toContain('startSessionWithPrompt(projectId, sessionId');
    expect(shell).toContain('attachedFilesToDataUrlParts(files)');
    expect(shell).toContain("prompt: ''");
    expect(shell).not.toContain('prompt: text');
  });

  test('project home hands the prompt (and its attachments) to the create', () => {
    expect(projectHomeSend).toContain('pending_prompt: {');
    expect(projectHomeSend).toContain('attachedFilesToDataUrlParts(files)');
    // The navigate stash is picks-only.
    expect(projectHomeSend).toContain("prompt: ''");
    expect(projectHomeSend).not.toContain('prompt: text');
    expect(projectHomeSend).not.toContain('setPendingFiles');
  });

  test('BOTH ProjectHome surfaces route their send through that one producer', () => {
    // The point of the extraction: a second composer must not be able to grow
    // its own send path and quietly go back to stashing the prompt.
    for (const [name, source] of [
      ['project index page', projectHomePage],
      ['subproject page', subprojectPage],
    ] as const) {
      expect({ name, usesSharedSend: source.includes('useProjectHomeSend(') }).toEqual({
        name,
        usesSharedSend: true,
      });
      expect({ name, writesItsOwnStash: source.includes('writeStartStash(') }).toEqual({
        name,
        writesItsOwnStash: false,
      });
    }
  });

  test('configure-thread and run-upgrade hand their prompt to the create', () => {
    expect(configureThread).toContain('create: { pending_prompt:');
    expect(configureThread).not.toContain('writeStartStash(');
    expect(runUpgrade).toContain('pendingUpgradePrompt(prompt)');
    expect(runUpgrade).not.toContain('writeStartStash(');
  });

  test('the session page POSTs a LEGACY metadata hand-off instead of re-stashing it', () => {
    expect(sessionPage).toContain('startSessionWithPrompt(projectId, sessionId');
    expect(sessionPage).not.toContain('startStashFromPendingSessionPrompt');
    // And it strips the metadata copy after the POST, so nothing double-sends.
    expect(sessionPage).toContain('pending_prompt: null');
  });

  test('the shell accepts a SECOND message during boot — the refusal is gone', () => {
    expect(shell).not.toContain('Still starting this session');
    expect(shell).not.toContain('carryDraft(');
    expect(shell).not.toContain('throw new Error(');
  });
});
