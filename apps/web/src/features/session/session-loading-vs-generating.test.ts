import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const chat = readFileSync(join(import.meta.dir, 'session-chat.tsx'), 'utf8');
const skeletonSource = readFileSync(
  join(import.meta.dir, 'session-transcript-skeleton.tsx'),
  'utf8',
);

/** Source with comments stripped — the assertions are about what RENDERS, and
 *  the doc comments here legitimately discuss the states by name. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = strip(chat);
// Comment-stripped too: this component's doc comment NAMES the states it is
// replacing ("Gathering thoughts…"), so asserting on raw source would fail
// against the explanation rather than the markup.
const skeleton = strip(skeletonSource);

/**
 * Reported 2026-08-29 on `pi-worker`: entering a session showed "Gathering
 * thoughts…" for ~30s over a transcript that had already rendered, then it
 * cleared by itself.
 *
 * LOADING and GENERATING are two different facts:
 *  - loading  → the transcript is being read back. Show its shape, say nothing.
 *  - generating → the agent is working. That is what the shimmer is for.
 *  - messages on screen → neither. No extra indicator at all.
 */
test('the turn card cannot show the generating shimmer on an uncorroborated server read', () => {
  // The gate is `showsGeneratingIndicator` (SDK, unit-tested there). What this
  // file must get right is USING it for the card and not for the composer.
  expect(code).toContain('showsGeneratingIndicator({');
  expect(code).toContain('projectionBusy: isBusy && generating');
});

test('the COMPOSER keeps the ungated projection — holding on a maybe-open turn is the safe direction', () => {
  // `/` commands go straight at OpenCode with no admission gate, so the
  // composer must stay conservative even when the indicator does not. If this
  // ever reads `generating`, a command could be dispatched into a live turn.
  expect(code).toContain('sessionWorking={effectiveBusy || hasRetryingAssistant}');
});

test('the transcript wait renders the skeleton, and the boot loader only covers a real boot', () => {
  expect(code).toContain('<SessionTranscriptSkeleton />');
  // The staged loader keeps the wait it was written for: a sandbox coming up.
  // Feeding it `runtimeReady ? 'ready' : 'starting'` is what made an ordinary
  // transcript read look like a cold start.
  expect(code).toContain('runtimeReady ? (');
  expect(code).not.toContain("stage={runtimeReady ? 'ready' : 'starting'}");
});

test('the skeleton is silent — no copy, no spinner, no stage names', () => {
  // Anything that narrates a 200ms read turns it into an event, and any word
  // about thinking would reintroduce the exact confusion being fixed.
  expect(skeleton).not.toContain('Loading…');
  expect(skeleton).not.toContain('Gathering');
  expect(skeleton).not.toContain('Thinking');
  expect(skeleton).not.toContain('<Loading');
  // Paired presence: it does render, and announces itself once as busy.
  expect(skeleton).toContain('<Skeleton');
  expect(skeleton).toContain('aria-busy="true"');
});

test('the skeleton keeps a stable shape across remounts', () => {
  // A randomized layout re-rolls on every remount, which reads as a second
  // load starting rather than one finishing.
  expect(skeleton).not.toContain('Math.random');
  expect(skeleton).toContain('const ROWS');
});
