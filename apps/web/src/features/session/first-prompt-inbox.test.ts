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
const shellSend = read('./use-instant-session-send.ts');
const projectHome = read('../../app/[locale]/(app)/projects/[id]/page.tsx');
// The project-home send's create-first delivery (the held-attachment block)
// lives beside the AttachmentSubmission owner since the page split; the facts
// below are pinned across both halves of that send path.
const heldDelivery = read('./composer/held-first-prompt.ts');
const homeSend = `${projectHome}\n${heldDelivery}`;
const sessionPage = read('../../app/[locale]/(app)/projects/[id]/sessions/[sessionId]/page.tsx');
const configureThread = read('../workspace/customize/use-configure-thread.ts');
const runUpgrade = read('../workspace/customize/migrate-to-v2/use-run-upgrade.ts');

describe('every first-prompt producer writes a durable row, not a prompt stash', () => {
  test('instant shell POSTs via startSessionWithPrompt with handle-only attachment parts', () => {
    expect(shell).toContain('useInstantSessionSend({');
    expect(shellSend).toContain('startSessionWithPrompt(projectId, sessionId');
    expect(shellSend).toContain('promptFileParts(files, attachmentParts)');
    expect(shellSend).toContain("prompt: ''");
    expect(shellSend).not.toContain('prompt: text');
  });

  test('project home hands the prompt (and its attachments) to the create', () => {
    expect(homeSend).toContain('pending_prompt: {');
    expect(homeSend).toContain('promptFileParts(files, attachmentParts)');
    // The navigate stash is picks-only.
    expect(homeSend).toContain("prompt: ''");
    expect(homeSend).not.toContain('prompt: text');
    expect(homeSend).not.toContain('setPendingFiles');
  });

  test('both first-message producers use the shared staging contract', () => {
    expect(shell).not.toContain('attachedFilesToDataUrlParts');
    expect(shellSend).not.toContain('attachedFilesToDataUrlParts');
    expect(projectHome).not.toContain('attachedFilesToDataUrlParts');
    expect(heldDelivery).not.toContain('attachedFilesToDataUrlParts');
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
