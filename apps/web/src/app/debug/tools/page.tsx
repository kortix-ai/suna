'use client';

import { useState } from 'react';
import {
  ToolPartRenderer,
  ToolActivateContext,
} from '@/components/session/tool-renderers';
import { SessionActionsPanel } from '@/components/session/session-actions-panel';
import { SessionFilesPanel } from '@/components/session/session-files-panel';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

/**
 * /debug/tools
 *
 * A visual harness for inspecting every core session tool renderer in
 * isolation — outside any live session, so you can stare at the chrome,
 * tweak shared primitives (BasicTool header/body, groupings), and verify
 * states (running / completed / error / empty) without driving an agent.
 *
 * Mirrors the chat column width so spacing reads true. Not linked from
 * anywhere — just hit /debug/tools.
 */

// ---------------------------------------------------------------------------
// Mock part builder — loose typing on purpose; this is a debug-only fixture.
// ---------------------------------------------------------------------------
let _id = 0;
function part(tool: string, state: Record<string, unknown>): any {
  _id += 1;
  return {
    id: `prt_dbg_${_id}`,
    messageID: 'msg_dbg',
    sessionID: 'ses_dbg',
    type: 'tool',
    callID: `call_dbg_${_id}`,
    tool,
    state,
  };
}

const done = (
  input: Record<string, unknown>,
  output: string,
  metadata: Record<string, unknown> = {},
  durationMs = 2400,
) => ({
  status: 'completed',
  input,
  output,
  metadata,
  time: { start: 1_000, end: 1_000 + durationMs },
});

const running = (input: Record<string, unknown>) => ({
  status: 'running',
  input,
  time: { start: 1_000 },
});

const errored = (input: Record<string, unknown>, error: string) => ({
  status: 'error',
  input,
  error,
  time: { start: 1_000, end: 3_000 },
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const BASH_OUTPUT = `> web@0.1.0 build
> next build

  ▲ Next.js 15.0.0
  Creating an optimized production build ...
✓ Compiled successfully in 4.2s
  Linting and checking validity of types ...
  Collecting page data ...
✓ Generating static pages (42/42)
  Finalizing page optimization ...`;

const EDIT_BEFORE = `export function add(a: number, b: number) {
  return a + b;
}`;
const EDIT_AFTER = `export function add(a: number, b: number): number {
  // guard against NaN inputs
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return a + b;
}`;

const WRITE_CONTENT = `:root {
  --radius: 1rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.15 0 0);
}

body {
  font-family: 'Roobert', sans-serif;
}`;

const GREP_OUTPUT = `Found 4 matches

/workspace/apps/web/src/app/page.tsx:
Line 12: import { Button } from '@/components/ui/button';
Line 48: <Button variant="default">Get started</Button>

/workspace/apps/web/src/components/header.tsx:
Line 3: import { Button } from '@/components/ui/button';
Line 27: <Button variant="ghost" size="sm">Sign in</Button>`;

const GLOB_OUTPUT = `/workspace/apps/web/src/components/ui/button.tsx
/workspace/apps/web/src/components/ui/badge.tsx
/workspace/apps/web/src/components/ui/card.tsx
/workspace/apps/web/src/components/ui/dialog.tsx`;

const LIST_OUTPUT = `/workspace/apps/web/src/app/page.tsx
/workspace/apps/web/src/app/layout.tsx
/workspace/apps/web/src/app/globals.css`;

type Row = { label: string; node: React.ReactNode };
type Group = { title: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: 'Shell',
    rows: [
      {
        label: 'completed',
        node: part(
          'bash',
          done(
            { command: 'pnpm --filter web build', description: 'Build the web app' },
            BASH_OUTPUT,
            {},
            4200,
          ),
        ),
      },
      {
        label: 'running',
        node: part('bash', running({ command: 'pnpm test --watch' })),
      },
      {
        label: 'error',
        node: part(
          'bash',
          errored(
            { command: 'pnpm typecheck' },
            "src/app/page.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
          ),
        ),
      },
    ],
  },
  {
    title: 'File edits',
    rows: [
      {
        label: 'edit (diff)',
        node: part(
          'edit',
          done(
            { filePath: '/workspace/apps/web/src/lib/math.ts' },
            '',
            {
              filediff: {
                additions: 3,
                deletions: 1,
                before: EDIT_BEFORE,
                after: EDIT_AFTER,
              },
            },
          ),
        ),
      },
      {
        label: 'write',
        node: part(
          'write',
          done(
            { filePath: '/workspace/apps/web/src/app/globals.css', content: WRITE_CONTENT },
            '',
          ),
        ),
      },
      {
        label: 'write (running)',
        node: part('write', running({ filePath: '/workspace/apps/web/src/app/new.css' })),
      },
    ],
  },
  {
    title: 'Context (read / search / list)',
    rows: [
      {
        label: 'read',
        node: part(
          'read',
          done(
            { filePath: '/workspace/apps/web/src/app/page.tsx' },
            '',
            {
              loaded: [
                '/workspace/apps/web/src/app/page.tsx',
                '/workspace/apps/web/src/app/layout.tsx',
              ],
            },
          ),
        ),
      },
      {
        label: 'grep',
        node: part(
          'grep',
          done({ pattern: 'Button', path: '/workspace/apps/web/src' }, GREP_OUTPUT),
        ),
      },
      {
        label: 'glob',
        node: part(
          'glob',
          done({ pattern: '**/ui/*.tsx', path: '/workspace/apps/web/src' }, GLOB_OUTPUT),
        ),
      },
      {
        label: 'list',
        node: part('list', done({ path: '/workspace/apps/web/src/app' }, LIST_OUTPUT)),
      },
      {
        label: 'grep (no matches)',
        node: part(
          'grep',
          done({ pattern: 'zzzznotfound', path: '/workspace' }, 'No matches found'),
        ),
      },
    ],
  },
  {
    title: 'Web',
    rows: [
      {
        label: 'web_search',
        node: part(
          'web_search',
          done(
            { query: 'next.js 15 app router streaming' },
            'Results for "next.js 15 app router streaming"',
          ),
        ),
      },
      {
        label: 'webfetch',
        node: part(
          'webfetch',
          done({ url: 'https://nextjs.org/docs/app' }, '# App Router\n\nThe App Router...'),
        ),
      },
    ],
  },
];

export default function DebugToolsPage() {
  const [open, setOpen] = useState(true);
  const focusToolCall = useKortixComputerStore((s) => s.focusToolCall);

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-background/80 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-base font-semibold">Tool renderers</h1>
          <p className="text-xs text-muted-foreground">
            /debug/tools — visual harness for session tool chrome
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          {open ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {/* Side-panel Actions view preview — the focused navigator that reuses
          the same ToolPartRenderer handlers, fed the mock tool parts. */}
      <div className="mx-auto w-full max-w-3xl px-6 pt-10">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Side panel · Actions
        </h2>
        <div className="h-[560px] w-full overflow-hidden rounded-2xl border border-border bg-card">
          <SessionActionsPanel
            sessionId="debug"
            messages={[
              {
                info: { id: 'm1', role: 'assistant' },
                parts: GROUPS.flatMap((g) => g.rows.map((r) => r.node)),
              } as any,
            ]}
          />
        </div>
      </div>

      {/* Side-panel Changes view preview — explanation + agent CR button +
          git-status list (empty here, no sandbox). */}
      <div className="mx-auto w-full max-w-3xl px-6 pt-10">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Side panel · Changes
        </h2>
        <div className="h-[420px] w-full overflow-hidden rounded-2xl border border-border bg-card">
          <SessionFilesPanel />
        </div>
      </div>

      {/* Inline chat rows — clicking one focuses the panel above (the same
          chat → side-panel flow), via ToolActivateContext + focusToolCall. */}
      <ToolActivateContext.Provider value={(callID) => focusToolCall(callID)}>
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <p className="mb-6 text-xs text-muted-foreground/60">
            Click any row below → it opens in the panel above. (Inline = chat
            presentation.)
          </p>
          {GROUPS.map((group) => (
            <section key={group.title} className="mb-12">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.title}
              </h2>
              <div className="space-y-3">
                {group.rows.map((row) => (
                  <div key={row.label}>
                    <div className="mb-1 text-xs font-mono uppercase tracking-wide text-muted-foreground/50">
                      {row.label}
                    </div>
                    <div className="rounded-2xl border border-border/40 bg-card/30 px-4 py-3">
                      <ToolPartRenderer
                        part={row.node as any}
                        sessionId="debug"
                        disableNavigation
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </ToolActivateContext.Provider>
    </div>
  );
}
