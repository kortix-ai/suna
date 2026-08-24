'use client';

import { UnifiedMarkdown } from '@/components/markdown';
import { ActivityBurst } from '@/features/session/turn/activity-burst';
import type { Part } from '@/ui';
import { m, useReducedMotion, type Transition } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useStepShowcaseStart } from '../use-step-showcase';

/**
 * One id, three jobs. `apps/api/src/projects/routes/r7.ts` states the invariant
 * outright: `session_id == sandbox_id == git branch name`. So there is no
 * `session/` branch prefix to show — the branch *is* the id.
 */
const SESSION = '7f2a1c94';

/** What the user asked for. */
const PROMPT = 'Fix the billing webhook retry and prove it with a test';

/**
 * The assistant's reply and the file it wrote — markdown, rendered by
 * `UnifiedMarkdown`.
 *
 * Two strings rather than one, because the tool calls land BETWEEN them and
 * three beats apart. Splitting at a seam the reveal already has is what lets
 * each half mount on its own beat with no placeholder holding its space.
 *
 * The fence is what draws the code card: `UnifiedMarkdown` routes it through
 * `MarkdownCode` → `CodeBlock`, so the language label, the copy button and the
 * Shiki highlighting are the product's own, not a lookalike.
 */
const REPLY_MD =
  'Booting an isolated machine for this session, then cloning the repo into `/workspace` and working there — nothing touches your laptop.';

const PATCH_MD = [
  '```ts',
  'export async function deliver(event: WebhookEvent) {',
  '  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {',
  '    const res = await post(event.url, event.body);',
  '    if (res.ok) return { delivered: true, attempt };',
  '',
  "    // A 4xx is the caller's problem. Retrying it only burns the budget.",
  '    if (res.status < 500) return { delivered: false, attempt };',
  '',
  '    await sleep(backoff(attempt));',
  '  }',
  '  return { delivered: false, attempt: MAX_ATTEMPTS };',
  '}',
  '```',
].join('\n');

/* ──────────────────────────────────────────────────────────────────────────
 * The tool calls
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Two mock `ToolPart`s, fed to the REAL `ActivityBurst`.
 *
 * Not a lookalike this time. `ActivityBurst` is the component the product draws
 * a run of tool calls with, and everything downstream of it is the real thing
 * too: `mergeBurstSteps` groups them, `burstSummaryLabel` writes the summary
 * line, `ChainOfThought` draws the rail, and `ToolPartRenderer` dispatches each
 * row to its registered renderer (`GrepTool`, `BashTool`). The only fiction is
 * the data.
 *
 * WHY THESE TWO TOOLS, AND WHY NOT TWO OF ONE
 *
 * `groupSteps` folds CONSECUTIVE calls of the same family into a single row —
 * two `bash` calls render as one "Ran 2 commands", not as the two rows this
 * design needs. `grep` is family `explore` and `bash` is family `run`
 * (`action-panel/shared/narration.ts`), so they stay apart and the chain has two
 * rows. Picking two tools that merely look right, and meeting the grouping rule
 * afterwards, is how a panel like this quietly ships with one row in it.
 *
 * `grep` rather than `read`: `read` is in `FILE_CHIP_TOOLS`, so a lone `read`
 * routes to `ActivityFileChipStep` and renders as a file chip — a different row
 * entirely, and not the one the reference shows.
 *
 * Both renderers are session-free, but `GrepTool` reaches `useOcFileOpen`, which
 * calls `useQueryClient()`. That is safe here only because `ReactQueryProvider`
 * sits in the ROOT layout (`app/layout.tsx`), above the marketing routes as well
 * as the app. If it ever moves under an `(app)` group, this panel throws on the
 * landing page.
 *
 * `satisfies Part[]`, never `as Part[]`. A cast on mock data is a promise the
 * compiler stops checking: the SDK owns this shape, `ToolStateCompleted`
 * requires all six of `status/input/output/title/metadata/time`, and the day a
 * field is added a cast would keep compiling and hand `undefined` to a renderer
 * at runtime. `satisfies` makes that a build error instead, which is the entire
 * value of typing fixtures at all.
 */
const MESSAGE_ID = 'msg_marketing_turn';

/** `ToolStateCompleted` is `{ status, input, output, title, metadata, time }` —
 *  every field required. `time` is what `ToolDurationContext` reads to print a
 *  row's duration, so the two spans below are the "12ms" and "6.2s" a reader
 *  sees, not filler. */
const TOOL_PARTS = [
  {
    id: 'prt_marketing_grep',
    sessionID: SESSION,
    messageID: MESSAGE_ID,
    type: 'tool',
    tool: 'grep',
    callID: 'call_marketing_grep',
    state: {
      status: 'completed',
      metadata: {},
      time: { start: 0, end: 120 },
      input: { pattern: 'MAX_ATTEMPTS', path: 'apps/api/src/billing' },
      output: [
        'apps/api/src/billing/webhook-retry.ts:12:const MAX_ATTEMPTS = 5;',
        'apps/api/src/billing/webhook-retry.ts:31:  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {',
        'apps/api/src/billing/webhook-retry.test.ts:8:  it("gives up after MAX_ATTEMPTS", () => {',
      ].join('\n'),
      title: 'MAX_ATTEMPTS',
    },
  },
  {
    id: 'prt_marketing_bash',
    sessionID: SESSION,
    messageID: MESSAGE_ID,
    type: 'tool',
    tool: 'bash',
    callID: 'call_marketing_bash',
    state: {
      status: 'completed',
      metadata: {},
      time: { start: 120, end: 6320 },
      input: {
        command: 'bun test apps/api/src/billing',
        description: 'Run the billing suite',
      },
      output: [
        'bun test v1.2.4',
        '',
        'apps/api/src/billing/webhook-retry.test.ts:',
        '  (pass) retries a 5xx with exponential backoff [12.40ms]',
        '  (pass) gives up after the 5th attempt [8.11ms]',
        '  (pass) does not retry a 4xx [3.02ms]',
        '',
        ' 3 pass, 0 fail, 7 expect() calls',
      ].join('\n'),
      title: 'bun test apps/api/src/billing',
    },
  },
] satisfies Part[];

/* ──────────────────────────────────────────────────────────────────────────
 * The reveal
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * How far the turn has got.
 *
 * 0 — nothing yet.
 * 1 — the prompt is in.
 * 2 — the agent has answered in prose.
 * 3 — first tool call landed.
 * 4 — second tool call landed.
 * 5 — the file it wrote. Final.
 */
const LAST_BEAT = 5;

/** Milliseconds before each beat, in order. The first is the beat of silence
 *  after the panel scrolls in — it makes the prompt read as SENT rather than as
 *  something that was already sitting there. */
const BEAT_DELAYS = [420, 900, 820, 760, 820];

/**
 * Plays the reveal ONCE and stops on the last beat.
 *
 * This replaced `useCliMovie`, which is a LOOP: it holds the finished frame for
 * three seconds, clears every block, waits, and plays the whole thing again.
 * Right for the panel it was written for — a terminal recording beside a live
 * view — and wrong here. This panel is a conversation, and a conversation that
 * erases itself every eight seconds does not read as a demo, it reads as a bug:
 * a reader who looks away for a moment comes back to an empty card. One pass,
 * and the finished turn stays for as long as the section does.
 *
 * Timers are collected so unmounting mid-reveal cannot land a `setState` on a
 * dead component — this panel lives in a list the reader scrolls straight past.
 */
function useTurnReveal(): { beat: number; start: () => void } {
  const reduced = useReducedMotion();
  const [beat, setBeat] = useState(0);
  const started = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // `start` is captured ONCE by `useStepShowcaseStart` (its effect has `[]`
  // deps), and `useReducedMotion` returns `null` on the first render before it
  // resolves to a boolean. Closing over `reduced` directly would bake in that
  // first `null` — falsy — and run the staged reveal for a reader who asked for
  // no motion. The ref is read at CALL time, the only moment the answer exists.
  //
  // Written in an effect rather than during render: `react-hooks/refs` forbids
  // the latter, and rightly — it is a render side effect. It lands well before
  // the IntersectionObserver can fire, because that observer is set up in an
  // effect too.
  const reducedRef = useRef(reduced);
  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    },
    [],
  );

  const start = useCallback(() => {
    if (started.current) return;
    started.current = true;

    // Reduced motion gets the finished turn immediately. The reveal is the one
    // thing here that is pure movement — nothing in it is information the
    // static frame does not already carry.
    if (reducedRef.current) {
      setBeat(LAST_BEAT);
      return;
    }

    let at = 0;
    BEAT_DELAYS.forEach((delay, index) => {
      at += delay;
      timers.current.push(setTimeout(() => setBeat(index + 1), at));
    });
  }, []);

  return { beat, start };
}

/** The one enter curve in this panel — the ease-out-quint the rest of the site
 *  enters on (`kx-fade-up`, globals.css). Not `as const`: motion types `ease` as
 *  a mutable 4-tuple and a readonly one does not satisfy it. */
const ENTER: Transition = { duration: 0.3, ease: [0.23, 1, 0.32, 1] };

/**
 * One block arriving.
 *
 * Small travel, no scale: these land INSIDE a clipped box, and anything that
 * scales in a clipped container tears at the edges. Reduced motion drops the
 * travel and keeps the fade — `useTurnReveal` has already jumped to the last
 * beat by then, so all four mount together and the fade is what marks them as
 * one arrival rather than as four.
 */
function Block({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();

  return (
    <m.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={ENTER}
      className={className}
    >
      {children}
    </m.div>
  );
}

/**
 * The user's turn.
 *
 * Surface and text scale copied from `UserMessageBubble` in
 * `features/session/turn/user-message.tsx` (its `BUBBLE_SURFACE` /
 * `BUBBLE_TEXT` constants) rather than imported: that module is the real chat
 * turn — XML parsers, attachment tiles, the image lightbox, two zustand stores
 * — and importing it would ship all of it to the landing page to reuse two
 * class strings. `rounded-xl` is theirs, not a lapse; this is the product's
 * bubble at the product's radius.
 */
function UserTurn(): ReactNode {
  return (
    <Block className="ml-auto flex w-full max-w-[80%] justify-end">
      <div className="bg-secondary text-foreground flex max-w-full flex-col rounded-lg px-3.5 py-2.5 text-[0.9rem] leading-[22px] font-medium wrap-break-word whitespace-pre-wrap select-none">
        {PROMPT}
      </div>
    </Block>
  );
}

/**
 * The agent's turn — the sheet the work lands in.
 *
 * STATIC HEIGHT is the design of this component, not a detail of it. The sheet
 * is `flex-1 min-h-0` inside the transcript column, so its height is a function
 * of the FRAME and of nothing else: exactly as tall holding one sentence as
 * holding a reply, two tool rows and a file. Nothing in the reveal resizes it,
 * so nothing in the reveal moves the bubble above it.
 *
 * Inside, blocks mount in DOM order, top to bottom, so appending block N cannot
 * move blocks 1…N−1. The last block is the code card, and it runs past the
 * floor rather than pushing anything — the mask on it is what turns that clip
 * into "there is more" instead of "this is broken".
 *
 * `working` stays TRUE for good, and that is a decision rather than an
 * oversight. `ActivityBurst` auto-collapses the moment its turn settles (its
 * `useEffect` on `running`), so a finished burst would fold itself back to a
 * single summary line — and an open chain is the whole point of this panel.
 * Holding the turn mid-flight keeps it open, keeps the summary shimmering, and
 * is honest: the agent has just written a patch and has not been told it is
 * done.
 */
function AgentTurn({ beat }: { beat: number }): ReactNode {
  const toolsShown = Math.max(0, Math.min(beat - 2, TOOL_PARTS.length));

  return (
    <div className="mx-auto flex min-h-0 w-[92%] flex-1 flex-col mask-b-from-50%">
      <div className="border-border bg-background flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-t-xl border border-b-0 px-5 pt-4 shadow-sm sm:px-6 sm:pt-5">
        {toolsShown > 0 && (
          <div className="shrink-0">
            {/* `isTrailing` for the same reason the product sets it on the last
                burst of a working turn: it is what holds the disclosure open
                across the gaps between calls instead of blinking it shut. */}
            <ActivityBurst
              parts={TOOL_PARTS.slice(0, toolsShown)}
              sessionId={SESSION}
              working
              isTrailing
              disableNavigation
            />
          </div>
        )}

        {beat >= 2 && (
          <div className="shrink-0">
            <UnifiedMarkdown
              content={REPLY_MD}
              className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            />
          </div>
        )}

        {/* The code card runs past the sheet's floor on purpose — that is where
            the reference gets its cut-off block. The mask lives HERE and not on
            the sheet: on the sheet it would fade the card's own left and right
            borders out along with the content, and the edges have to stay crisp
            all the way down.

            `[&_pre]:overflow-hidden` overrides `CodeBlock`'s `overflow-auto`.
            These panels sit in a long scroll section, and a scrollable region
            here swallows the wheel the moment the pointer crosses it — the
            reader gets stuck on the page with no idea why. */}
        {beat >= LAST_BEAT && (
          <div className="min-h-0 flex-1">
            <UnifiedMarkdown
              content={PATCH_MD}
              className="[&_pre]:overflow-hidden [&>*:first-child]:mt-0"
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The session, as a transcript.
 *
 * This replaced a browser-chrome wrapper (`WebPanelWrapper`) around two
 * side-by-side data panels. The wrapper's tab said "Sandbox" and the panels
 * listed facts about a sandbox — a spec sheet, and a spec sheet cannot show
 * something happening. A transcript can: the prompt goes in, and the work comes
 * back a block at a time.
 *
 * It carries no surface of its own. The frame it sits in (`StepPane` /
 * `MobileCard` in how-it-works.tsx) is already `bg-muted/40 rounded-xl border`,
 * so a bordered panel here drew a second hairline 0px outside the first — two
 * edges stacked, which reads as a rendering fault rather than as two objects.
 * The frame IS the surface; the sheet is the only chrome.
 *
 * The message region is `shrink-0` and the sheet is `flex-1`: the bubble is as
 * tall as its text and stays there, and every pixel of slack — at 448px and at
 * 512px alike — belongs to the sheet.
 */
function SessionTranscript({ beat }: { beat: number }): ReactNode {
  return (
    <div className="bg-muted/40 flex h-full min-h-0 flex-col gap-4 rounded-xl p-6 pb-0">
      <div className="shrink-0 px-5 sm:px-6">{beat >= 1 && <UserTurn />}</div>
      <AgentTurn beat={beat} />
    </div>
  );
}

/** Layer 05 — every session gets its own computer, and its own branch. */
export function StepComputer(): ReactNode {
  const { beat, start } = useTurnReveal();
  const rootRef = useStepShowcaseStart(start);

  return (
    <div ref={rootRef} className="h-full w-full">
      <SessionTranscript beat={beat} />
    </div>
  );
}
