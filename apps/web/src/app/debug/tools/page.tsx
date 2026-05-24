'use client';

import { useTranslations } from 'next-intl';

import { useState } from 'react';
import {
  ToolPartRenderer,
  ToolActivateContext,
} from '@/components/session/tool-renderers';
import { SessionActionsPanel } from '@/components/session/session-actions-panel';
import { SessionFilesPanel } from '@/components/session/session-files-panel';
import { SessionExplorerPanel } from '@/components/session/session-explorer-panel';
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
        label: 'read (file content)',
        node: part(
          'read',
          done(
            { filePath: '/workspace/apps/web/src/lib/math.ts' },
            '<path>/workspace/apps/web/src/lib/math.ts</path>\n<type>file</type>\n<content>\n1: export function add(a: number, b: number): number {\n2:   // guard against NaN inputs\n3:   if (Number.isNaN(a) || Number.isNaN(b)) return 0;\n4:   return a + b;\n5: }\n</content>',
          ),
        ),
      },
      {
        label: 'read (directory)',
        node: part(
          'read',
          done(
            { filePath: '/workspace' },
            '<path>/workspace</path>\n<type>directory</type>\n<entries>\n.git/\nsrc/\npackage.json\nREADME.md\n\n(4 entries)\n</entries>',
          ),
        ),
      },
      {
        label: 'read (loaded list)',
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
        label: 'webfetch (markdown)',
        node: part(
          'webfetch',
          done({ url: 'https://nextjs.org/docs/app', format: 'markdown' }, '# App Router\n\nThe App Router is a new paradigm for building applications using React’s latest features.'),
        ),
      },
      {
        label: 'webfetch (html)',
        node: part(
          'webfetch',
          done(
            { url: 'https://nextjs.org/docs/app', format: 'html' },
            '<!DOCTYPE html>\n<html>\n<head>\n<title>App Router – Next.js</title>\n<style>body{font:14px sans-serif}</style>\n</head>\n<body>\n<h1>App Router</h1>\n<p>The App Router is a new paradigm for building applications using React’s latest features such as Server Components and streaming.</p>\n<p>It lives in the <code>app/</code> directory.</p>\n</body>\n</html>',
          ),
        ),
      },
    ],
  },
  {
    title: 'Planning & interaction',
    rows: [
      {
        label: 'todowrite',
        node: part(
          'todowrite',
          done(
            {
              todos: [
                { content: 'Create project directory and generate palette', status: 'completed', priority: 'high' },
                { content: 'Build the portfolio HTML with full design system', status: 'in_progress', priority: 'high' },
                { content: 'Preview the site via static server', status: 'pending', priority: 'high' },
                { content: 'Playwright QA screenshots at desktop + mobile', status: 'pending', priority: 'medium' },
                { content: 'Polish and fix any issues found in QA', status: 'pending', priority: 'medium' },
              ],
            },
            '',
          ),
        ),
      },
      {
        label: 'todowrite (running)',
        node: part('todowrite', running({})),
      },
      {
        label: 'question (single, answered)',
        node: part(
          'question',
          done(
            {
              questions: [
                {
                  header: 'Site type',
                  question: 'What kind of site are you looking for? Give me a quick description and I’ll run with it.',
                  options: [
                    { label: 'Personal / portfolio', description: 'A simple personal landing page, portfolio, or bio site' },
                    { label: 'Small business / brand', description: 'A landing page for a brand, product, or small business' },
                    { label: 'Fun / experimental', description: 'A playful or experimental micro-site' },
                    { label: 'Dashboard / tool', description: 'A small web app, dashboard, or utility tool' },
                  ],
                },
              ],
            },
            'User has answered your questions: "What kind of site are you looking for?"="Personal / portfolio". You can now continue.',
            { answers: [['Personal / portfolio']] },
          ),
        ),
      },
      {
        label: 'question (multi, answered)',
        node: part(
          'question',
          done(
            {
              questions: [
                {
                  header: 'Framework',
                  question: 'Which framework should we use?',
                  options: [
                    { label: 'Next.js', description: 'App Router, RSC' },
                    { label: 'Remix', description: 'Nested routes' },
                  ],
                },
                {
                  header: 'Styling',
                  question: 'How should we style it?',
                  options: [
                    { label: 'Tailwind', description: 'Utility-first' },
                    { label: 'CSS Modules', description: 'Scoped CSS' },
                  ],
                },
              ],
            },
            'answered',
            { answers: [['Next.js'], ['Tailwind']] },
          ),
        ),
      },
    ],
  },
];

export default function DebugToolsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(true);
  const focusToolCall = useKortixComputerStore((s) => s.focusToolCall);

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-background/80 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-base font-semibold">{tHardcodedUi.raw('appDebugToolsPage.line268JsxTextToolRenderers')}</h1>
          <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('appDebugToolsPage.line270JsxTextDebugToolsVisualHarnessForSessionToolChrome')}</p>
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
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{tHardcodedUi.raw('appDebugToolsPage.line286JsxTextSidePanelActions')}</h2>
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
          {tHardcodedUi.raw('appDebugToolsPage.line305JsxTextSidePanelChanges')}</h2>
        <div className="h-[420px] w-full overflow-hidden rounded-2xl border border-border bg-card">
          <SessionFilesPanel />
        </div>
      </div>

      {/* Side-panel Files view preview — the in-sandbox explorer. Without a live
          sandbox it shows its "not reachable" empty state. */}
      <div className="mx-auto w-full max-w-3xl px-6 pt-10">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Side panel · Files (explorer)
        </h2>
        <div className="h-[420px] w-full overflow-hidden rounded-2xl border border-border bg-card">
          <SessionExplorerPanel />
        </div>
      </div>

      {/* Inline chat rows — clicking one focuses the panel above (the same
          chat → side-panel flow), via ToolActivateContext + focusToolCall. */}
      <ToolActivateContext.Provider value={(callID) => focusToolCall(callID)}>
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <p className="mb-6 text-xs text-muted-foreground/60">{tHardcodedUi.raw('appDebugToolsPage.line306JsxTextClickAnyRowBelowItOpensInThe')}</p>
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
