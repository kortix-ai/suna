'use client';

import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { ActivityBurst } from '@kortix/ui/session';
import { useLocalizedUiCatalog } from '@kortix/ui/i18n';
import type { ToolCallBlock } from '@kortix/sdk';
import { cn } from '@kortix/ui';
import { m, useReducedMotion, type Transition } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Layer 05 — every session gets its own computer.
 *
 * The panel plays real-looking sessions, one after another, the way a turn
 * streams in the product: the prompt lands, each tool call shows up running and
 * then completes, the reply streams in a few words at a time, and some turns
 * end with a code block that streams in line by line. Every session is
 * different, and not every one ends in code.
 *
 * Tool rows go through the REAL `ActivityBurst`, so the rail, the summary line
 * and each row's renderer are the product's own; only the data is fiction.
 * Consecutive calls must come from different tool families (`familyForTool`):
 * `groupSteps` folds two calls of one family into a single row.
 *
 * A burst stays open only while it is the live edge of the turn. When the
 * reply moves on past it, it folds to its "N steps" summary, as in the product.
 */

const SESSION = '7f2a1c94';

type Tool = {
  name: 'grep' | 'bash' | 'edit' | 'web_search';
  input: Record<string, unknown>;
  title: string;
  output: string;
  /** How long the call shows as running, in ms. */
  ms: number;
};

type Step =
  | { kind: 'tool'; tool: Tool }
  | { kind: 'text'; md: string }
  | { kind: 'code'; lang: string; code: string };

type Session = { id: string; prompt: string; steps: Step[] };

/**
 * Five sessions, each a different kind of work, each long enough to read as a
 * real turn. Synthetic data only: no customer, person or real ID. Tool order
 * alternates families (explore / run / edit / web) so every call is its own
 * row.
 */
const SESSIONS: Session[] = [
  {
    id: 'webhook',
    prompt: 'Fix the billing webhook retry and prove it with a test',
    steps: [
      {
        kind: 'tool',
        tool: {
          name: 'grep',
          input: { pattern: 'MAX_ATTEMPTS', path: 'apps/api/src/billing' },
          title: 'MAX_ATTEMPTS',
          output: [
            'apps/api/src/billing/webhook-retry.ts:12:const MAX_ATTEMPTS = 5;',
            'apps/api/src/billing/webhook-retry.ts:31:  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {',
            'apps/api/src/billing/webhook-retry.test.ts:8:  it("gives up after MAX_ATTEMPTS", () => {',
          ].join('\n'),
          ms: 700,
        },
      },
      {
        kind: 'tool',
        tool: {
          name: 'bash',
          input: { command: 'bun test apps/api/src/billing', description: 'Reproduce the failure' },
          title: 'bun test apps/api/src/billing',
          output: ' 2 pass, 1 fail — "does not retry a 4xx" retried 5 times',
          ms: 1400,
        },
      },
      {
        kind: 'text',
        md: 'Found it. `deliver()` retries every non-2xx response, so a `404` from a deleted endpoint burns all five attempts and the queue backs up behind it. A 4xx is the caller’s problem; only a 5xx or a timeout should retry.',
      },
      {
        kind: 'tool',
        tool: {
          name: 'edit',
          input: {
            filePath: 'apps/api/src/billing/webhook-retry.ts',
            oldString: '    if (res.ok) return { delivered: true, attempt };',
            newString:
              '    if (res.ok) return { delivered: true, attempt };\n    if (res.status < 500) return { delivered: false, attempt };',
          },
          title: 'apps/api/src/billing/webhook-retry.ts',
          output: 'Edited 1 file',
          ms: 900,
        },
      },
      {
        kind: 'tool',
        tool: {
          name: 'bash',
          input: { command: 'bun test apps/api/src/billing', description: 'Run the billing suite' },
          title: 'bun test apps/api/src/billing',
          output: ' 3 pass, 0 fail, 7 expect() calls',
          ms: 1500,
        },
      },
      {
        kind: 'text',
        md: [
          'Fixed and proven on this session’s own machine — nothing ran on your laptop.',
          '',
          '- A `4xx` now returns at once, without a retry.',
          '- A `5xx` still retries with exponential backoff, up to 5 attempts.',
          '- The suite passes: **3 pass, 0 fail**.',
          '',
          'The change, in `webhook-retry.ts`:',
        ].join('\n'),
      },
      {
        kind: 'code',
        lang: 'ts',
        code: [
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
        ].join('\n'),
      },
    ],
  },
  {
    id: 'release-notes',
    prompt: 'Write the release notes for everything we merged this week',
    steps: [
      {
        kind: 'tool',
        tool: {
          name: 'bash',
          input: {
            command: 'git log --merges --since="7 days ago" --pretty="%s"',
            description: 'List this week’s merges',
          },
          title: 'git log --merges --since="7 days ago"',
          output: [
            'feat(sessions): warm machines start in under 2 s',
            'feat(connectors): scope each connector to the agents that may use it',
            'fix(billing): stop retrying webhooks on a 4xx',
            'fix(web): keep the composer draft across tab switches',
            '… 10 more',
          ].join('\n'),
          ms: 1100,
        },
      },
      {
        kind: 'tool',
        tool: {
          name: 'grep',
          input: { pattern: 'BREAKING CHANGE', path: '.' },
          title: 'BREAKING CHANGE',
          output: 'No matches',
          ms: 650,
        },
      },
      {
        kind: 'text',
        md: [
          '14 merges this week, and none of them breaks an existing setup. Here is a draft you can paste into the changelog:',
          '',
          '**What’s new**',
          '',
          '- **Faster session start.** A warm machine is ready in under 2 seconds, so a new session opens almost at once.',
          '- **Scoped connectors.** Choose which agents may use each connector; the rest never see it.',
          '',
          '**Fixes**',
          '',
          '- Webhook deliveries no longer retry a `4xx` response.',
          '- The composer keeps your draft when you switch tabs.',
          '- 10 smaller fixes across the web app and the CLI.',
          '',
          'Want me to open a pull request that adds this to `CHANGELOG.md`?',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'rate-limit',
    prompt: 'Add a rate limit to the public API, 100 requests a minute per key',
    steps: [
      {
        kind: 'tool',
        tool: {
          name: 'grep',
          input: { pattern: 'createRouter', path: 'apps/api/src' },
          title: 'createRouter',
          output: 'apps/api/src/router/index.ts:18:export const api = createRouter();',
          ms: 650,
        },
      },
      {
        kind: 'text',
        md: 'Every public route mounts on one router, so the limit belongs there: one place, and no route can opt out by accident. I’ll key it on the API key, not the IP, so one noisy client cannot starve the others behind the same proxy.',
      },
      {
        kind: 'tool',
        tool: {
          name: 'edit',
          input: {
            filePath: 'apps/api/src/router/index.ts',
            oldString: 'export const api = createRouter();',
            newString:
              'export const api = createRouter().use(\n  rateLimit({ perMinute: 100, key: (req) => req.apiKey }),\n);',
          },
          title: 'apps/api/src/router/index.ts',
          output: 'Edited 1 file',
          ms: 900,
        },
      },
      {
        kind: 'tool',
        tool: {
          name: 'bash',
          input: { command: 'bun test apps/api/src/router', description: 'Run the router tests' },
          title: 'bun test apps/api/src/router',
          output: ' 11 pass, 0 fail',
          ms: 1300,
        },
      },
      {
        kind: 'text',
        md: [
          'Done. Each API key now gets **100 requests a minute**. Request 101 answers `429 Too Many Requests` with a `Retry-After` header, and the window resets on the minute. I added two tests for it: one at the limit and one past it.',
        ].join('\n'),
      },
      {
        kind: 'code',
        lang: 'ts',
        code: [
          'export const api = createRouter().use(',
          '  rateLimit({',
          '    perMinute: 100,',
          '    key: (req) => req.apiKey,',
          "    onLimit: (res, retryAfter) => res.status(429).set('Retry-After', retryAfter),",
          '  }),',
          ');',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'vector-db',
    prompt: 'Compare the three vector databases we shortlisted and pick one',
    steps: [
      {
        kind: 'tool',
        tool: {
          name: 'web_search',
          input: { query: 'pgvector vs Qdrant vs Weaviate recall latency benchmark' },
          title: 'pgvector vs Qdrant vs Weaviate recall latency benchmark',
          output: '8 results',
          ms: 1400,
        },
      },
      {
        kind: 'tool',
        tool: {
          name: 'bash',
          input: {
            command: 'bun run bench:vectors --docs 2_000_000',
            description: 'Benchmark all three on our own data',
          },
          title: 'bun run bench:vectors --docs 2_000_000',
          output: [
            'pgvector  recall@10 0.94  p95 38 ms',
            'Qdrant    recall@10 0.96  p95 21 ms',
            'Weaviate  recall@10 0.95  p95 29 ms',
          ].join('\n'),
          ms: 1900,
        },
      },
      {
        kind: 'text',
        md: [
          'I ran all three on a copy of our 2 million documents, on this session’s machine.',
          '',
          '- **Qdrant** is the fastest (21 ms at p95) and recalls the most, but it is one more service to run, back up and secure.',
          '- **Weaviate** sits in the middle on both, and its hosted plan costs the most at our size.',
          '- **pgvector** is 2 points behind on recall and 17 ms slower, and it runs inside the Postgres we already operate.',
          '',
          '**Pick pgvector.** At our traffic 38 ms is well inside the 100 ms budget, and it adds no new system. Revisit Qdrant if we pass 20 million documents.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'flaky-test',
    prompt: 'The checkout test fails about once in ten runs. Find out why',
    steps: [
      {
        kind: 'tool',
        tool: {
          name: 'bash',
          input: {
            command: 'for i in $(seq 50); do bun test checkout.test.ts || echo FAIL $i; done',
            description: 'Run the test 50 times',
          },
          title: 'bun test checkout.test.ts × 50',
          output: 'FAIL 7\nFAIL 23\nFAIL 41\n47 pass, 3 fail',
          ms: 1800,
        },
      },
      {
        kind: 'tool',
        tool: {
          name: 'grep',
          input: { pattern: 'new Date\\(|Date.now\\(', path: 'apps/web/src/checkout' },
          title: 'new Date(|Date.now(',
          output: 'apps/web/src/checkout/coupon.ts:22:  if (coupon.expiresAt < Date.now()) return null;',
          ms: 650,
        },
      },
      {
        kind: 'text',
        md: 'Three failures in 50 runs, all in “applies a coupon that expires today”. The fixture builds a coupon that expires at the end of the current second, and `coupon.ts` compares it against the real clock. When a run crosses a second boundary, the coupon is already expired.',
      },
      {
        kind: 'tool',
        tool: {
          name: 'edit',
          input: {
            filePath: 'apps/web/src/checkout/checkout.test.ts',
            oldString: "  const coupon = makeCoupon({ expiresAt: endOfSecond() });",
            newString: "  setSystemTime(new Date('2026-06-01T12:00:00Z'));\n  const coupon = makeCoupon({ expiresAt: endOfDay() });",
          },
          title: 'apps/web/src/checkout/checkout.test.ts',
          output: 'Edited 1 file',
          ms: 900,
        },
      },
      {
        kind: 'tool',
        tool: {
          name: 'bash',
          input: {
            command: 'for i in $(seq 200); do bun test checkout.test.ts || echo FAIL $i; done',
            description: 'Run it 200 times',
          },
          title: 'bun test checkout.test.ts × 200',
          output: '200 pass, 0 fail',
          ms: 2000,
        },
      },
      {
        kind: 'text',
        md: 'Fixed: the test now freezes the clock and gives the coupon a whole day. **200 runs, 0 failures.** The product code was right; only the test raced the clock.',
      },
    ],
  },
];

/* ──────────────────────────────────────────────────────────────────────────
 * The stream
 * ────────────────────────────────────────────────────────────────────────── */

/** Where one session has got to. `done` steps are final; `live` is the step
 *  streaming now, with `chars` of its text shown (text and code only). */
type Frame = { session: number; prompt: boolean; done: number; live: number | null; chars: number };

const START: Frame = { session: 0, prompt: false, done: 0, live: null, chars: 0 };

/** Pauses, in ms. Chosen to read as a real turn at a glance, not to be fast. */
const BEFORE_PROMPT = 500;
const AFTER_PROMPT = 650;
const BETWEEN_STEPS = 350;
const TEXT_TICK = 45; // one word per tick
const CODE_TICK = 140; // one line per tick

/** The next cut point of a streaming text step: the end of the next word. */
function nextWord(md: string, from: number): number {
  const space = md.indexOf(' ', from + 1);
  return space === -1 ? md.length : space;
}

/** The next cut point of a streaming code step: the end of the next line. */
function nextLine(code: string, from: number): number {
  const nl = code.indexOf('\n', from + 1);
  return nl === -1 ? code.length : nl;
}

/**
 * Drives the frames. Each page load picks ONE session at random and plays it
 * once; the finished turn then stays. A reload is how a reader sees another.
 * The pick happens after mount, so server and client render the same first
 * frame (nothing is shown before the prompt lands).
 *
 * Runs only while the panel is on screen: off screen the pending timer is
 * cleared, and the stream resumes from the same frame when the panel comes
 * back. Reduced motion shows the picked session finished.
 */
function useSessionStream(sessions: Session[]) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [frame, setFrame] = useState<Frame>(START);
  const [picked, setPicked] = useState(false);
  const pickedRef = useRef(false);
  // Read at call time in the observer callback, where the answer exists.
  const reducedRef = useRef(reduced);
  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
        // The first time the panel is seen: pick this load's session. Reduced
        // motion gets it finished, at once.
        if (!entry.isIntersecting || pickedRef.current) return;
        pickedRef.current = true;
        const session = Date.now() % sessions.length;
        setFrame(
          reducedRef.current
            ? { ...START, session, prompt: true, done: sessions[session].steps.length }
            : { ...START, session },
        );
        setPicked(true);
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sessions]);

  useEffect(() => {
    if (!picked || reduced || !visible) return;

    const session = sessions[frame.session];
    let delay: number;
    let next: Frame;

    if (!frame.prompt) {
      delay = BEFORE_PROMPT;
      next = { ...frame, prompt: true };
    } else if (frame.live === null && frame.done < session.steps.length) {
      // Start the next step.
      delay = frame.done === 0 ? AFTER_PROMPT : BETWEEN_STEPS;
      next = { ...frame, live: frame.done, chars: 0 };
    } else if (frame.live !== null) {
      const step = session.steps[frame.live];
      if (step.kind === 'tool') {
        // A tool call shows running for its own duration, then completes.
        delay = step.tool.ms;
        next = { ...frame, live: null, done: frame.done + 1 };
      } else {
        const body = step.kind === 'text' ? step.md : step.code;
        if (frame.chars >= body.length) {
          delay = 0;
          next = { ...frame, live: null, done: frame.done + 1 };
        } else {
          delay = step.kind === 'text' ? TEXT_TICK : CODE_TICK;
          next = {
            ...frame,
            chars: step.kind === 'text' ? nextWord(body, frame.chars) : nextLine(body, frame.chars),
          };
        }
      }
    } else {
      // Finished. The turn stays as it is.
      return;
    }

    const id = setTimeout(() => setFrame(next), delay);
    return () => clearTimeout(id);
  }, [frame, visible, reduced, sessions, picked]);

  return { ref, frame };
}

/* ──────────────────────────────────────────────────────────────────────────
 * The turn
 * ────────────────────────────────────────────────────────────────────────── */

/** The enter curve the rest of the site uses (`kx-fade-up`, globals.css). */
const ENTER: Transition = { duration: 0.3, ease: [0.23, 1, 0.32, 1] };

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

/** Surface and text copied from `UserMessageBubble`
 *  (`packages/ui/src/session/turn/user-message.tsx`), not imported: that module
 *  is the whole chat turn and would ship to the landing page for two strings. */
function UserTurn({ prompt }: { prompt: string }): ReactNode {
  return (
    <Block className="ml-auto flex w-full max-w-[80%] justify-end">
      <div className="bg-secondary text-foreground flex max-w-full flex-col rounded-lg px-3.5 py-2.5 text-[0.9rem] leading-[22px] font-medium wrap-break-word whitespace-pre-wrap select-none">
        {prompt}
      </div>
    </Block>
  );
}

/** A mock call in the SDK's own shape. `satisfies`, never `as`: a new SDK field
 *  must be a build error here, not `undefined` in a renderer. */
function toolBlock(sessionId: string, index: number, tool: Tool, running: boolean): ToolCallBlock {
  const block = {
    type: 'tool_call',
    id: `prt_marketing_${sessionId}_${index}`,
    call_id: `call_marketing_${sessionId}_${index}`,
    name: tool.name,
    kind: tool.name === 'bash' ? 'shell' : tool.name,
    status: running ? 'running' : 'complete',
    started_at: new Date(0).toISOString(),
    ...(running ? {} : { ended_at: new Date(tool.ms).toISOString() }),
    input: tool.input,
    title: tool.title,
    ...(running
      ? {}
      : { result: { is_error: false, content: [{ type: 'text', text: tool.output }] } }),
  } satisfies ToolCallBlock;
  return block;
}

/**
 * The agent's turn, in step order. Tool calls that sit next to each other share
 * one `ActivityBurst`, as they do in the product; text and code break the run.
 * Blocks only ever append, so a new one never moves the ones above it. The
 * sheet has a fixed height and a fade at its foot, so a long turn runs past
 * the floor instead of resizing the panel.
 */
function AgentTurn({ session, frame }: { session: Session; frame: Frame }): ReactNode {
  const shown = frame.live === null ? frame.done : frame.live + 1;

  const groups: ReactNode[] = [];
  let burst: ToolCallBlock[] = [];
  let burstStart = 0;
  // Keyed by the burst's first step, so a burst keeps its key (and does not
  // replay its entrance) when the text after it arrives.
  // Only the burst at the live edge of a turn still in progress is trailing.
  // Once text follows a burst, or the turn ends, it stops running and
  // `ActivityBurst` folds itself to its "N steps" line, as in the product.
  const finished = frame.live === null && frame.done === session.steps.length;
  const flush = (trailing: boolean) => {
    if (burst.length === 0) return;
    groups.push(
      <Block key={`burst-${burstStart}`} className="shrink-0">
        <ActivityBurst
          blocks={burst}
          sessionId={SESSION}
          working={trailing}
          isTrailing={trailing}
          disableNavigation
        />
      </Block>,
    );
    burst = [];
  };

  session.steps.slice(0, shown).forEach((step, i) => {
    const live = frame.live === i;
    if (step.kind === 'tool') {
      if (burst.length === 0) burstStart = i;
      burst.push(toolBlock(session.id, i, step.tool, live));
      return;
    }
    flush(false);
    if (step.kind === 'text') {
      groups.push(
        <Block key={`text-${i}`} className="shrink-0">
          <UnifiedMarkdown
            content={live ? step.md.slice(0, frame.chars) : step.md}
            trust="trusted"
            className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          />
        </Block>,
      );
    } else {
      // `[&_pre]:overflow-hidden` overrides `CodeBlock`'s `overflow-auto`: a
      // scrollable region inside a long scroll section swallows the wheel.
      const code = live ? step.code.slice(0, frame.chars) : step.code;
      groups.push(
        <Block key={`code-${i}`} className="min-h-0 shrink-0">
          <UnifiedMarkdown
            content={`\`\`\`${step.lang}\n${code}\n\`\`\``}
            trust="trusted"
            className="[&_pre]:overflow-hidden [&>*:first-child]:mt-0"
          />
        </Block>,
      );
    }
  });
  flush(!finished);

  return <div className="flex shrink-0 flex-col gap-3 pt-4 sm:pt-5">{groups}</div>;
}

/**
 * Follows the stream the way the product's thread does: while the turn grows
 * past the panel's floor, the sheet stays pinned to its newest line, and the
 * prompt scrolls up and out under a fade. `overflow-hidden`, not `auto`: the
 * scroll is the panel's, never the reader's — a scrollable region inside a
 * long scroll section swallows the wheel.
 */
function useFollowStream(frame: Frame) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setScrolled(el.scrollTop > 0);
  }, [frame]);
  return { ref, scrolled };
}

export function StepComputer(): ReactNode {
  const sessions = useLocalizedUiCatalog(SESSIONS);
  const { ref, frame } = useSessionStream(sessions);
  const { ref: followRef, scrolled } = useFollowStream(frame);
  const session = sessions[frame.session];

  return (
    <div ref={ref} className="h-full w-full">
      <div
        ref={followRef}
        className={cn(
          'flex h-full min-h-0 flex-col overflow-hidden',
          scrolled && 'mask-t-from-80%',
        )}
      >
        {frame.prompt && <UserTurn prompt={session.prompt} />}
        <AgentTurn session={session} frame={frame} />
      </div>
    </div>
  );
}
