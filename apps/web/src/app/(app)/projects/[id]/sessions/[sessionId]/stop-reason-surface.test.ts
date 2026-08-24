/**
 * The resolver is only worth what the card does with it. `page.tsx` cannot be
 * unit-tested here (no DOM under `bun test`, and it is a client component
 * behind a lazy boundary), so the wiring is pinned against the source — the
 * same approach `sso-entry.test.ts` and the action-panel call-site tests take.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

describe('the stopped card explains itself', () => {
  test('it asks the resolver for copy, keyed on the typed wire field', () => {
    expect(page).toContain("import { stopReasonCopy } from '@/features/session/stop-reason-copy'");
    // The typed field, not a hand-read of the metadata blob — that untyped
    // read is what this change exists to replace.
    expect(page).toContain('stopReasonCopy(sandbox?.stop_reason)');
    expect(page).not.toContain('metadata?.stopReason');
  });

  test('the generic copy survives as a fallback, never as the only answer', () => {
    // A row parked before stop_reason reached the wire has nothing recorded.
    // Losing the fallback would replace an unexplained card with a blank one.
    expect(page).toContain('stoppedCopy?.title ??');
    expect(page).toContain('stoppedCopy?.message ??');
    expect(page).toContain(
      'appProjectsIdSessionsSessionidPage.line151JsxAttrMessageTheSandboxForThisSessionWasStoppedOpen',
    );
  });

  test('the Restart action is untouched', () => {
    // This change is about words. Whether a restart is offered stays the
    // server's call via `retriable`; copy must not start gating the button.
    expect(page).toContain('<RestartSessionButton restart={restart} onRestart={handleRestart} />');
    expect(page).not.toContain('restartLikelyHelps &&');
  });

  test('the terminal lost screen is left alone', () => {
    // `provider_removed` reaches the dedicated hard-stop card ABOVE this one,
    // which offers no restart at all. The stopped card must not start
    // duplicating it.
    expect(page).toContain('title="This session\'s computer was lost"');
  });
});
