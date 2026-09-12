'use client';

/**
 * /debug/split-sheet
 *
 * Review harness for `SplitSheet` (components/ui/split-sheet.tsx). Not linked
 * from anywhere.
 *
 * SplitSheet responds to the width of its own root, not the window. The Frame
 * control narrows the root in place: 384 and 672 show the stacked layout (the
 * sheet replaces the page), 1024 and Fill show the split. The readout in the
 * header prints the live root width.
 *
 * Check by hand:
 * - Open a row, scroll the page, switch Frame to 384, close: the page keeps its scroll.
 * - Tab to "New session", press Enter: the sheet opens with no animation and
 *   focus lands in it. Escape closes it and focus returns to the button.
 * - Open a session, then click "New session": the sheet swaps to the form instead of closing.
 * - Light and dark: the split hairline and the panel surface.
 */

import { CaretRightIcon, PlusIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  SplitSheet,
  SplitSheetBody,
  SplitSheetClose,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetMain,
  SplitSheetTitle,
  SplitSheetTrigger,
  type SplitSheetSize,
} from '@/components/ui/split-sheet';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** `@3xl` = 48rem at a 16px root. Mirrors the breakpoint in split-sheet.tsx for the readout only. */
const SPLIT_AT_PX = 768;

type Frame = 'phone' | 'tablet' | 'laptop' | 'fill';

const FRAMES: { value: Frame; label: string; className: string }[] = [
  { value: 'phone', label: '384', className: 'max-w-sm' },
  { value: 'tablet', label: '672', className: 'max-w-2xl' },
  { value: 'laptop', label: '1024', className: 'max-w-5xl' },
  { value: 'fill', label: 'Fill', className: 'max-w-none' },
];

const SIZES: SplitSheetSize[] = ['xs', 'sm', 'md', 'lg'];

type DemoSession = {
  id: string;
  title: string;
  branch: string;
  updated: string;
  status: 'Running' | 'Idle' | 'Failed';
  model: string;
  sandbox: string;
};

const SESSIONS: DemoSession[] = [
  ['Fix the flaky sessions route test', 'fix/sessions-402', '2 min ago', 'Running'],
  ['Add retry budget to the trigger worker', 'feat/trigger-retry', '14 min ago', 'Running'],
  ['Migrate connector catalog to Composio sections', 'connector-flow', '1 hr ago', 'Idle'],
  ['Stream compaction card in place', 'feat/compaction-stream', '2 hr ago', 'Idle'],
  ['Investigate staging deploy rollback', 'ops/staging-rollback', '3 hr ago', 'Failed'],
  ['Serbian locale: finish hardcoded UI keys', 'i18n-complete-serbian', '5 hr ago', 'Idle'],
  ['Tighten modal stack z-order on nested confirms', 'fix/modal-stack', 'Yesterday', 'Idle'],
  ['Profile SSE reconnect storm under load', 'perf/sse-reconnect', 'Yesterday', 'Failed'],
  ['Replace list primitives in the secrets view', 'chore/secrets-rows', '2 days ago', 'Idle'],
  ['Document the SDK session hook lifecycle', 'docs/use-session', '2 days ago', 'Idle'],
  ['Desktop: remember the chosen instance', 'desktop/instance-chooser', '3 days ago', 'Idle'],
  ['Wallpaper shader fallback without WebGL', 'fix/shader-fallback', '4 days ago', 'Idle'],
  ['Credits tab: split usage from billing', 'feat/credits-split', '5 days ago', 'Idle'],
  ['Review Center: inline detail via query param', 'feat/review-inline', '1 week ago', 'Idle'],
].map(([title, branch, updated, status], index) => ({
  id: `ses_${(index + 1).toString().padStart(2, '0')}`,
  title: title as string,
  branch: branch as string,
  updated: updated as string,
  status: status as DemoSession['status'],
  model: index % 3 === 0 ? 'claude-opus-5' : 'claude-sonnet-5',
  sandbox: `sbx-${(48213 + index * 977).toString(16)}`,
}));

const ACTIVITY = [
  ['09:02', 'Provisioned sandbox'],
  ['09:02', 'Cloned repository at main'],
  ['09:03', 'Ran pnpm install'],
  ['09:05', 'Read apps/api/src/routes/sessions.ts'],
  ['09:06', 'Reproduced the failure: expected 402, received 500'],
  ['09:08', 'Traced the 500 to an unhandled capacity error'],
  ['09:11', 'Edited apps/api/src/routes/sessions.ts'],
  ['09:12', 'Added a regression test for provider capacity'],
  ['09:14', 'Ran bun test src/routes/sessions.test.ts'],
  ['09:15', '14 passed, 0 failed'],
  ['09:16', 'Ran tsc --noEmit'],
  ['09:18', 'Ran eslint on changed files'],
  ['09:19', 'Committed fix(sessions): return 402 at capacity'],
  ['09:20', 'Pushed fix/sessions-402'],
  ['09:21', 'Opened draft pull request'],
  ['09:24', 'Waiting for CI'],
];

type Panel = { kind: 'new' } | { kind: 'session'; id: string } | null;

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

export default function DebugSplitSheetPage() {
  const [frame, setFrame] = useState<Frame>('fill');
  const [size, setSize] = useState<SplitSheetSize>('md');
  const [panel, setPanel] = useState<Panel>(null);
  const [frameRef, width] = useElementWidth<HTMLDivElement>();

  const session =
    panel?.kind === 'session' ? (SESSIONS.find((item) => item.id === panel.id) ?? null) : null;
  const frameClassName = FRAMES.find((item) => item.value === frame)?.className;

  return (
    <div className="bg-background flex h-dvh flex-col antialiased">
      <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-foreground text-sm font-medium">SplitSheet</h1>
          <p className="text-muted-foreground text-xs tabular-nums">
            {width === null
              ? 'Measuring root width'
              : `Root ${width}px, ${width >= SPLIT_AT_PX ? 'side by side' : 'stacked'}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={frame} onValueChange={(value) => setFrame(value as Frame)} className="w-fit">
            <TabsListCompact type="default" aria-label="Frame width">
              {FRAMES.map((item) => (
                <TabsTriggerCompact key={item.value} value={item.value}>
                  {item.label}
                </TabsTriggerCompact>
              ))}
            </TabsListCompact>
          </Tabs>
          <Tabs
            value={size}
            onValueChange={(value) => setSize(value as SplitSheetSize)}
            className="w-fit"
          >
            <TabsListCompact type="default" aria-label="Sheet size">
              {SIZES.map((item) => (
                <TabsTriggerCompact key={item} value={item}>
                  {item}
                </TabsTriggerCompact>
              ))}
            </TabsListCompact>
          </Tabs>
        </div>
      </header>

      <div className="bg-card flex min-h-0 flex-1 justify-center p-2 sm:p-4">
        <div
          ref={frameRef}
          className={cn(
            'bg-background h-full w-full overflow-hidden rounded-md border',
            frameClassName,
          )}
        >
          <SplitSheet
            size={size}
            open={panel !== null}
            onOpenChange={(open) => setPanel(open ? { kind: 'new' } : null)}
          >
            <SplitSheetMain>
              <div className="@container mx-auto w-full max-w-2xl space-y-5 px-4 py-10 pb-20">
                <header className="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">
                  <div className="min-w-0 space-y-1">
                    <h2 className="text-foreground text-xl font-medium">Sessions</h2>
                    <p className="text-muted-foreground text-sm text-pretty">
                      Pick a session to inspect it. The page narrows instead of going dark.
                    </p>
                  </div>
                  <SplitSheetTrigger
                    asChild
                    onClick={(event) => {
                      // Showing a session? Swap to the form instead of toggling closed.
                      if (panel?.kind === 'session') {
                        event.preventDefault();
                        setPanel({ kind: 'new' });
                      }
                    }}
                  >
                    <Button size="sm" variant="secondary" className="w-fit shrink-0 gap-1.5">
                      <PlusIcon className="size-4 shrink-0" />
                      New session
                    </Button>
                  </SplitSheetTrigger>
                </header>

                <ul role="list" className="space-y-2">
                  {SESSIONS.map((item) => {
                    const selected = panel?.kind === 'session' && panel.id === item.id;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setPanel({ kind: 'session', id: item.id })}
                          className={cn(
                            'bg-popover hover:bg-hover focus-visible:ring-ring flex w-full cursor-pointer items-center gap-3 rounded-md border px-4 py-2 text-left outline-none focus-visible:ring-2',
                            selected && 'bg-active hover:bg-active',
                          )}
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-foreground truncate text-sm font-medium">
                              {item.title}
                            </span>
                            <span className="text-muted-foreground truncate text-xs">
                              {item.branch}, {item.updated}
                            </span>
                          </span>
                          <Badge variant="outline" size="sm">
                            {item.status}
                          </Badge>
                          <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </SplitSheetMain>

            <SplitSheetContent>
              {panel?.kind === 'new' ? (
                <NewSessionSheet onStart={() => setPanel(null)} />
              ) : session ? (
                <SessionSheet session={session} />
              ) : null}
            </SplitSheetContent>
          </SplitSheet>
        </div>
      </div>
    </div>
  );
}

function NewSessionSheet({ onStart }: { onStart: () => void }) {
  return (
    <>
      <SplitSheetHeader>
        <SplitSheetTitle>New session</SplitSheetTitle>
        <SplitSheetDescription>Starts a sandbox on the default branch.</SplitSheetDescription>
      </SplitSheetHeader>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          onStart();
        }}
      >
        <SplitSheetBody className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="split-sheet-demo-title">Title</Label>
            <Input id="split-sheet-demo-title" placeholder="Fix the flaky sessions route test" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="split-sheet-demo-prompt">Prompt</Label>
            <Textarea
              id="split-sheet-demo-prompt"
              rows={6}
              placeholder="The sessions route returns 500 when the provider is at capacity. It should return 402."
            />
          </div>
        </SplitSheetBody>
        <SplitSheetFooter>
          <SplitSheetClose asChild>
            <Button type="button" variant="outline-ghost" size="sm">
              Cancel
            </Button>
          </SplitSheetClose>
          <Button type="submit" size="sm">
            Start session
          </Button>
        </SplitSheetFooter>
      </form>
    </>
  );
}

function SessionSheet({ session }: { session: DemoSession }) {
  const fields: [string, string, boolean?][] = [
    ['Status', session.status],
    ['Branch', session.branch, true],
    ['Model', session.model, true],
    ['Sandbox', session.sandbox, true],
    ['Updated', session.updated],
  ];

  return (
    <>
      <SplitSheetHeader>
        <SplitSheetTitle>{session.title}</SplitSheetTitle>
        <SplitSheetDescription>
          {session.branch}, updated {session.updated}
        </SplitSheetDescription>
      </SplitSheetHeader>
      {/* Keyed so a different session starts at the top instead of inheriting the scroll offset. */}
      <SplitSheetBody key={session.id} className="space-y-8">
        <dl className="space-y-3 text-sm">
          {fields.map(([term, detail, mono]) => (
            <div key={term} className="flex items-baseline justify-between gap-6">
              <dt className="text-muted-foreground shrink-0">{term}</dt>
              <dd
                className={cn('text-foreground min-w-0 truncate text-right', mono && 'font-mono')}
              >
                {detail}
              </dd>
            </div>
          ))}
        </dl>
        <section className="space-y-3">
          <h3 className="text-foreground text-sm font-medium">Activity</h3>
          <ol role="list" className="space-y-3">
            {ACTIVITY.map(([time, label], index) => (
              <li key={index} className="flex items-baseline gap-3 text-xs">
                <span className="text-muted-foreground w-10 shrink-0 tabular-nums">{time}</span>
                <span className="text-foreground min-w-0 flex-1">{label}</span>
              </li>
            ))}
          </ol>
        </section>
      </SplitSheetBody>
      <SplitSheetFooter>
        <SplitSheetClose asChild>
          <Button variant="outline-ghost" size="sm">
            Close
          </Button>
        </SplitSheetClose>
        <Button size="sm">Open session</Button>
      </SplitSheetFooter>
    </>
  );
}
