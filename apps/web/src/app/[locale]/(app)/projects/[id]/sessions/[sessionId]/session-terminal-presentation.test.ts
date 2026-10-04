import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every terminal state on this route presents TWICE, and the pair must agree:
 *
 *  • no transcript → a full-screen `InlineSessionError` (the card replaces the
 *    route; nothing is readable, so nothing is covered);
 *  • a transcript  → a composer-slot notice (`SessionNoticeProps`), so the
 *    conversation stays on screen and nothing covers it.
 *
 * The pair shares ONE title and ONE action. The notice's message prefers the
 * restart error when there is one (the user is mid-retry; the raw state copy
 * would read as a contradiction), while the full-screen card keeps the state's
 * own words AND adds the restart error as its monospace detail line. The
 * provider-failure and lost-computer states escalate to `tone: 'destructive'`;
 * the legacy-restore and stopped states keep the default tone.
 *
 * Since the card-or-notice pairs collapsed into `presentTerminal`, each state
 * states its props ONCE and the presenter fans them to both shapes — so the
 * shared-title/shared-action facts are pinned at the call sites together with
 * the presenter's wiring. Source-scan, like the boot-overlay contract: these
 * pairs are data wired across two render shapes, and no render of a mock shows
 * both halves at once.
 */
const routeDir = import.meta.dir;
const page = readFileSync(resolve(routeDir, 'page.tsx'), 'utf8');
const cards = readFileSync(resolve(routeDir, 'session-route-cards.tsx'), 'utf8');

function between(start: string, end: string): string {
  const from = page.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = page.indexOf(end, from + start.length);
  expect(to, `anchor not found after ${start}: ${end}`).toBeGreaterThan(from);
  return page.slice(from, to);
}

describe('each terminal state presents one card-or-notice pair', () => {
  test('the presenter fans one title and one action to both shapes', () => {
    const helper = cards.slice(cards.indexOf('export function presentTerminal('));
    // Full-screen card: the state's own words plus the detail line.
    expect(helper).toContain(
      '<InlineSessionError title={title} message={message} detail={detail} action={action} />',
    );
    // Composer-slot notice: same title and action, the caller's noticeMessage,
    // and the tone only when the state passes one.
    expect(helper).toContain(
      'notice: { ...(tone ? { tone } : {}), title, message: noticeMessage, action },',
    );
  });

  test('provisioning/provider failure: destructive, restart error as detail on the card only', () => {
    const block = between('const failureRecovery = (', '// Stopped, with no sandbox row');
    expect(block).toContain('presentTerminal({');
    expect(block).toContain('title: recoverableFailure.title');
    expect(block).toContain('message: failureMessage');
    expect(block).toContain('noticeMessage: restart.errorMessage ?? failureMessage');
    expect(block).toContain('detail: restart.errorMessage ?? undefined');
    expect(block).toContain('action: failureRecovery');
    expect(block).toContain("tone: 'destructive'");
  });

  test('legacy migrated session: restore CTA, default tone', () => {
    const block = between(
      'isLegacyMigratedSession(currentProjectSession)) {',
      "title: tSessionPage('stopped.title')",
    );
    expect(block).toContain("title: tSessionPage('legacy.title')");
    expect(block).toContain("message: tSessionPage('legacy.message')");
    expect(block).toContain("noticeMessage: restart.errorMessage ?? tSessionPage('legacy.message')");
    expect(block).toContain('detail: restart.errorMessage ?? undefined');
    expect(block).toContain('action: restoreAction');
    expect(block).not.toContain('tone:');
  });

  test('dormant without runtime: plain Restart, default tone', () => {
    const block = between("title: tSessionPage('stopped.title')", '// The provider lost this session');
    expect(block).toContain("message: tSessionPage('stopped.message')");
    expect(block).toContain("noticeMessage: restart.errorMessage ?? tSessionPage('stopped.message')");
    expect(block).toContain('detail: restart.errorMessage ?? undefined');
    expect(block).toContain('action: <RestartSessionButton restart={restart} onRestart={handleRestart} />,');
    expect(block).not.toContain('tone:');
  });

  test('lost computer: delete-only CTA, destructive, provider detail on the card only', () => {
    const block = between('// The provider lost this session', 'if (fatal &&');
    expect(block).toContain("title: tSessionPage('lost.title')");
    expect(block).toContain("message: tSessionPage('lost.message')");
    expect(block).toContain("noticeMessage: tSessionPage('lost.message')");
    expect(block).toContain(
      'detail: sandbox?.external_id ? `${sandbox.provider} · ${sandbox.external_id}` : undefined,',
    );
    expect(block).toContain('action: deleteAction');
    expect(block).toContain("tone: 'destructive'");
    // The lost computer is never restartable: the card must not offer Restart.
    expect(block).not.toContain('RestartSessionButton');
  });

  test('exactly the four states present as card-or-notice pairs', () => {
    // The recoverable-failure, legacy, stopped, and lost states each call the
    // presenter; the transcript branch itself exists exactly once, inside it.
    expect(page.match(/presentTerminal\(\{/g)?.length).toBe(4);
    expect(cards.match(/if \(!hasTranscript\) \{/g)?.length).toBe(1);
  });
});
