import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { fileURLToPath } from 'node:url';

import {
  firstPromptBubbleTone,
  firstPromptRowIsLive,
  firstPromptStandInBusy,
  pendingBubbleIsMuted,
} from './first-prompt-presentation';

// Source anchors, same rationale as `session-chat-busy-row-fallback.test.ts`:
// `SessionChat` has no DOM harness in this app, and what is under test is that
// the decision above is the one the render runs. `between()` FAILS on a missing
// anchor rather than yielding '' and passing.
//
// Every anchor is matched against WHITESPACE-COLLAPSED source, so re-indenting
// the JSX or wrapping the element in one more conditional cannot fail a test
// whose decision is unchanged.
function squish(source: string): string {
  return source.replace(/\s+/g, ' ');
}

const chat = squish(
  readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8'),
);
const shell = squish(
  readFileSync(fileURLToPath(new URL('./instant-session-shell.tsx', import.meta.url)), 'utf8'),
);

// `toContain` on a whole squished source file prints the file on failure. This
// reports the missing anchor instead.
function expectAnchor(source: string, anchor: string): void {
  expect(source.includes(squish(anchor)), `anchor not found: ${anchor}`).toBe(true);
}

function between(source: string, start: string, end: string): string {
  const startAt = squish(start);
  const endAt = squish(end);
  const from = source.indexOf(startAt);
  expect(from, `anchor not found: ${startAt}`).toBeGreaterThan(-1);
  const to = source.indexOf(endAt, from + startAt.length);
  expect(to, `anchor not found after ${startAt}: ${endAt}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('pendingBubbleIsMuted — one look for the first prompt, from Send to acceptance', () => {
  // The boot shell draws this exact prompt in full colour. Muting it the frame
  // the chat takes over turned the user's own message grey — as if it had been
  // disabled — for as long as /prompts and /turn took to agree.
  test('the first prompt of a session is never muted while it waits', () => {
    expect(
      pendingBubbleIsMuted({ firstPrompt: true, pending: true, interruptedBeforeRun: false }),
    ).toBe(false);
  });

  test('a prompt queued behind a running turn is muted — it is waiting, not running', () => {
    expect(
      pendingBubbleIsMuted({ firstPrompt: false, pending: true, interruptedBeforeRun: false }),
    ).toBe(true);
  });

  test('an answered or running bubble is never muted', () => {
    expect(
      pendingBubbleIsMuted({ firstPrompt: false, pending: false, interruptedBeforeRun: false }),
    ).toBe(false);
    expect(
      pendingBubbleIsMuted({ firstPrompt: true, pending: false, interruptedBeforeRun: false }),
    ).toBe(false);
  });

  // A Stop ended the turn before a step opened under it. Nothing is running for
  // this message, first prompt or not, and the meta row says so.
  test('a prompt interrupted before it ran stays muted, first prompt included', () => {
    expect(
      pendingBubbleIsMuted({ firstPrompt: true, pending: false, interruptedBeforeRun: true }),
    ).toBe(true);
    expect(
      pendingBubbleIsMuted({ firstPrompt: false, pending: true, interruptedBeforeRun: true }),
    ).toBe(true);
  });
});

describe('the transcript runs these decisions', () => {
  test('the user bubble takes its muted class from pendingBubbleIsMuted', () => {
    const slice = between(chat, 'className={cn( pendingBubbleIsMuted({', 'QUEUED_BUBBLE_OPACITY_CLASS');
    expect(slice).toContain('firstPrompt: !!isFirstPrompt,');
    expect(slice).toContain('pending,');
    expect(slice).toContain('interruptedBeforeRun: !!interruptedBeforeRun,');
    // The scroll anchor and the busy-row rules read this attribute; only the
    // CLASS changes. See `pickAnchorIndex`.
    expect(chat).toContain('data-turn-pending={pending || interruptedBeforeRun || undefined}');
  });

  test('the first prompt is named by its inbox row or by the re-mint claim', () => {
    const slice = between(chat, 'const isFirstPrompt =', ';');
    expect(slice).toContain('isFirstPromptRow(pendingPrompt)');
    expect(slice).toContain('firstTurnClaim?.messageId');
    expect(chat).toContain('isFirstPrompt={isFirstPrompt}');
  });

  test('the stand-in row reads the live first-prompt inbox row', () => {
    expect(chat).toContain('const firstPromptLive = firstPromptRowIsLive(firstPromptRow);');
    expect(between(chat, 'busy={firstPromptStandInBusy({', '})}')).toContain('firstPromptLive,');
  });

  // Parity, the point of R3: the shell hands the chat a row in the same state.
  // A row that exists decides; no row yet means the POST is still in flight.
  test('the boot shell judges its waiting row by the same rule', () => {
    expect(shell).toContain('busy={!firstPromptRow || firstPromptRowIsLive(firstPromptRow)}');
  });
});

describe('firstPromptRowIsLive — a prompt the server is holding for us', () => {
  test('a queued first prompt is live', () => {
    expect(firstPromptRowIsLive({ state: 'queued', reason: null })).toBe(true);
  });

  test('a prompt being delivered is live', () => {
    expect(firstPromptRowIsLive({ state: 'delivering', reason: null })).toBe(true);
  });

  test('no row at all is not live', () => {
    expect(firstPromptRowIsLive(undefined)).toBe(false);
  });

  test('a failed first prompt is not live — its failure is the status', () => {
    expect(firstPromptRowIsLive({ state: 'failed', reason: 'last_error' })).toBe(false);
  });

  // A Stop during boot HOLDS the first prompt: the row stays `queued` and gains
  // `reason: 'held'` (`holdSessionPrompts`; `projectQueueRows` counts the same
  // pair). Nothing is running, the composer shows Send, and a waiting row over
  // a prompt the user deliberately stopped is a lie.
  test('a first prompt a Stop held is not live', () => {
    expect(firstPromptRowIsLive({ state: 'queued', reason: 'held' })).toBe(false);
  });

  test('a prompt merely waiting its turn is still live', () => {
    expect(firstPromptRowIsLive({ state: 'waiting', reason: 'turn_active' })).toBe(true);
  });
});

describe('firstPromptBubbleTone — one tint for the first prompt, from Send to acceptance', () => {
  // No row yet means the POST is still in flight. The bubble is already on
  // screen and must not start untinted and gain its tint a frame later.
  test('a first prompt with no row yet is tinted pending', () => {
    expect(firstPromptBubbleTone(undefined)).toBe('pending');
  });

  test('a queued or delivering first prompt is tinted pending', () => {
    expect(firstPromptBubbleTone({ state: 'queued', reason: null })).toBe('pending');
    expect(firstPromptBubbleTone({ state: 'delivering', reason: null })).toBe('pending');
    expect(firstPromptBubbleTone({ state: 'waiting', reason: 'turn_active' })).toBe('pending');
  });

  // The same answer `queuedBubbleTone` gives the real turn once it lands, so
  // the bubble does not change colour under the handover.
  test('a first prompt a Stop held is tinted held', () => {
    expect(firstPromptBubbleTone({ state: 'queued', reason: 'held' })).toBe('held');
  });

  test('a failed first prompt is tinted failed', () => {
    expect(firstPromptBubbleTone({ state: 'failed', reason: 'last_error' })).toBe('failed');
    // Failure wins over a hold: the row gave up, whatever put it there.
    expect(firstPromptBubbleTone({ state: 'failed', reason: 'held' })).toBe('failed');
  });
});

describe('both first-prompt surfaces run firstPromptBubbleTone', () => {
  // R3's whole point. The shell tinted the bubble and the chat's stand-in did
  // not, so the first prompt went yellow → plain → yellow across the handover,
  // and a failed send lost its red tint, its sentence and its Retry with it.
  test('the boot shell tints its first-prompt bubble by the shared rule', () => {
    expectAnchor(shell, 'data-queue-tone={firstPromptBubbleTone(firstPromptRow)}');
  });

  test('the chat stand-in tints its bubble by the same rule', () => {
    expectAnchor(chat, 'data-queue-tone={firstPromptBubbleTone(firstPromptRow)}');
  });

  test('the chat stand-in keeps the failure sentence and its Retry', () => {
    const slice = between(chat, 'busy={firstPromptStandInBusy({', '/>');
    expect(slice).toContain('leadingStatus=');
    expect(slice).toContain('<QueuedPromptFailure');
    expect(slice).toContain('failureCode={firstPromptRow.failure_code}');
    expect(slice).toContain('handleRetryQueuedMessage(firstPromptRow.prompt_id)');
  });
});

describe('firstPromptStandInBusy — the waiting row survives the shell handover', () => {
  // The shell's row is busy for as long as the prompt has not failed. The chat
  // stand-in used to read the working projection alone, so any idle frame at
  // the crossfade dropped the row the shell had been holding.
  test('a live first-prompt row is busy even where the projection reads idle', () => {
    expect(
      firstPromptStandInBusy({
        transcriptHasTurns: false,
        firstPromptLive: true,
        lastTurnWorking: false,
      }),
    ).toBe(true);
  });

  test('a failed first prompt draws no waiting row — its failure is the status', () => {
    expect(
      firstPromptStandInBusy({
        transcriptHasTurns: false,
        firstPromptLive: false,
        lastTurnWorking: false,
      }),
    ).toBe(false);
  });

  test('a working session is busy once the row has drained but no turn shows yet', () => {
    expect(
      firstPromptStandInBusy({
        transcriptHasTurns: false,
        firstPromptLive: false,
        lastTurnWorking: true,
      }),
    ).toBe(true);
  });

  // Two waiting rows would be a lie about how much is running: once a turn is
  // on screen it draws its own (`resolveBusyRow`).
  test('a transcript with a turn in it draws no stand-in row at all', () => {
    expect(
      firstPromptStandInBusy({
        transcriptHasTurns: true,
        firstPromptLive: true,
        lastTurnWorking: true,
      }),
    ).toBe(false);
  });
});
