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

test('the gate takes no presence inputs — corroboration was the wrong question', () => {
  // The first version withheld a server read only until the stream
  // "corroborated" it. Control frames carry the same ledger rows, so a stale
  // row corroborated itself and the shimmer returned. Source is the answer.
  expect(code).not.toContain('streamCorroborated:');
  expect(code).not.toContain('useSessionTurnCorroborated(');
});

test('the COMPOSER keeps the ungated projection — holding on a maybe-open turn is the safe direction', () => {
  // `/` commands go straight at OpenCode with no admission gate, so the
  // composer must stay conservative even when the indicator does not. If this
  // ever reads `generating`, a command could be dispatched into a live turn.
  expect(code).toContain('sessionWorking={effectiveBusy}');
  expect(code).toContain('hasRetryingAssistant,');
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

/**
 * "apply the same thing here and at any other state where it has something
 * visible in the UI when doing SSE" — reported 2026-08-29, after the shimmer
 * was fixed and the Stop button was still showing over a session with nothing
 * to stop.
 *
 * ONE rule for every visible affordance: the runtime's own stream, or this
 * tab's own send. Never a poll.
 */
const layout = strip(readFileSync(join(import.meta.dir, 'session-layout.tsx'), 'utf8'));

test('THE INTERRUPT AFFORDANCE fails SAFE — isBusy keeps the broad answer', () => {
  // Reported 2026-08-29 on pi: a long answer had NO Stop button, because this
  // was gated on `generating`. A pi-worker runtime emits no status frames, so
  // a real streaming turn is visible only through the `/turn` read; once the
  // send receipt aged out, the escape hatch vanished mid-answer.
  //
  // The two directions are not symmetric. Stop shown with nothing running is
  // one dead click; Stop hidden with a turn running means the user cannot stop
  // their own agent. So this stays broad.
  expect(code).toContain('useState(effectiveBusy)');
  expect(code).toContain('}, [effectiveBusy]);');
  expect(code).not.toContain('useState(visiblyBusy)');
});

test('the SHIMMER stays strict — a poll may never claim the agent is thinking', () => {
  // The claim needs the runtime's own voice, which is what keeps "Gathering
  // thoughts…" off a finished transcript when a stale ledger row is open.
  expect(code).toContain('const generating = showsGeneratingIndicator({ projection: working })');
  expect(code).toContain('projectionBusy: isBusy && generating');
});

test('the COMMAND gate keeps the ungated projection too', () => {
  // A `/` command goes straight at the runtime with no admission gate, so
  // holding it over a turn that MIGHT be open is correct.
  expect(code).toContain('sessionWorking={effectiveBusy}');
  expect(code).toContain('hasRetryingAssistant,');
});

test('the layout panel keeps the broad answer, for the same asymmetry', () => {
  // Narrowing it was tried and reverted: with no status frames on pi, this
  // panel went blind to real work. A stale row makes the ready chip late,
  // which is the harmless direction.
  expect(layout).toContain("? working.state === 'working'");
  expect(layout).not.toContain('showsGeneratingIndicator');
});
