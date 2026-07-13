'use client';

import { useTranslations } from 'next-intl';

import { AdvancedPanel } from '@/features/session/action-panel/advanced/advanced-panel';
import { EasyPanel } from '@/features/session/action-panel/easy/easy-panel';
import { FileViewer } from '@/features/session/action-panel/easy/file-viewer';
import { SessionFilesExplorer } from '@/features/session/session-files-explorer';
import { SessionFilesPanel } from '@/features/session/session-files-panel';
import { ToolActivateContext, ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import type { MessageWithParts } from '@/ui';
import { useState } from 'react';

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

// ---------------------------------------------------------------------------
// FileViewer fixture — the sandbox fetch behind FilePreview always
// fails on this page (no live sandbox), so the toggle can't be reached
// through Outputs. Render it directly with realistic content: one markdown
// file (proves the Preview/Raw split + real DocMarkdown rendering) and one
// non-markdown file (proves the source-only path — no tabs, just a language
// label).
// ---------------------------------------------------------------------------
const MARKDOWN_PREVIEW_CONTENT = `# Jay Suthar

## Summary

Frontend engineer focused on **design systems** and *motion-first* UI. Ships
polished, production-grade interfaces and enjoys sweating the details other
teams skip.

## Highlights

- Rebuilt the Easy-mode session panel's detail layer as an inset card, not a
  full-bleed sheet
- Cut card body padding to match content density per section
- Replaced the file-manager drill-in with a single-file \`FilePreview\`
- Shipped \`FileViewer\` — rendered preview, copy, download and full screen

## Example

Here's a minimal handler used in the file-preview fallback path:

\`\`\`ts
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return \`\${(bytes / 1024 ** i).toFixed(1)} \${units[i]}\`;
}
\`\`\`

Read more on the [Kortix design system](https://kortix.com) or ping me on
Slack.
`;

const TS_SOURCE_CONTENT = `import { useCallback, useState } from 'react';

export interface Counter {
  value: number;
  increment: () => void;
  reset: () => void;
}

/** A minimal counter hook — used here only to prove Shiki highlighting on a
 * non-markdown file inside \`FileViewer\`'s source-only path. */
export function useCounter(initial = 0): Counter {
  const [value, setValue] = useState(initial);

  const increment = useCallback(() => {
    setValue((v) => v + 1);
  }, []);

  const reset = useCallback(() => {
    setValue(initial);
  }, [initial]);

  return { value, increment, reset };
}
`;

/** HTML is the ONE file type whose rendered form and source are both worth
 *  seeing, so it is the only one FileViewer gives a Preview/Source toggle. */
const HTML_PREVIEW_CONTENT = `<!doctype html>
<meta charset="utf-8" />
<title>Pricing comparison</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.sub { color: #666; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #e5e5e5; padding: 8px 10px; text-align: left; }
  th { background: #fafafa; font-weight: 600; }
</style>
<h1>Pricing comparison</h1>
<p class="sub">Generated from 5 sources</p>
<table>
  <tr><th>Plan</th><th>Acme</th><th>Globex</th></tr>
  <tr><td>Starter</td><td>$19/mo</td><td>$25/mo</td></tr>
  <tr><td>Team</td><td>$49/mo</td><td>$45/mo</td></tr>
  <tr><td>Enterprise</td><td>Custom</td><td>Custom</td></tr>
</table>
`;

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
      {
        label: 'pty_spawn',
        node: part(
          'pty_spawn',
          done(
            { command: 'pnpm dev', title: 'Dev server' },
            '<pty_spawned>\nID: pty_4f2a\nTitle: Dev server\nCommand: pnpm dev\nStatus: running\nPID: 48213\nWorkdir: /workspace/apps/web\n</pty_spawned>',
          ),
        ),
      },
      {
        label: 'pty_read',
        node: part(
          'pty_read',
          done(
            { id: 'pty_4f2a' },
            '<pty_output id="pty_4f2a" status="running">\n00001| $ pnpm dev\n00002| ▲ Next.js 16.0.0\n00003| - Local:  http://localhost:3000\n00004| ✓ Ready in 1.2s\n(End of buffer — 4 lines total)\n</pty_output>',
          ),
        ),
      },
      {
        label: 'pty_write',
        node: part('pty_write', done({ id: 'pty_4f2a', input: 'rs\n' }, 'ok')),
      },
      {
        label: 'pty_kill',
        node: part('pty_kill', done({ id: 'pty_4f2a' }, 'Process pty_4f2a terminated.')),
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
          done({ filePath: '/workspace/apps/web/src/lib/math.ts' }, '', {
            filediff: {
              additions: 3,
              deletions: 1,
              before: EDIT_BEFORE,
              after: EDIT_AFTER,
            },
          }),
        ),
      },
      {
        label: 'write',
        node: part(
          'write',
          done({ filePath: '/workspace/apps/web/src/app/globals.css', content: WRITE_CONTENT }, ''),
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
          done({ filePath: '/workspace/apps/web/src/app/page.tsx' }, '', {
            loaded: [
              '/workspace/apps/web/src/app/page.tsx',
              '/workspace/apps/web/src/app/layout.tsx',
            ],
          }),
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
          done(
            { url: 'https://nextjs.org/docs/app', format: 'markdown' },
            '# App Router\n\nThe App Router is a new paradigm for building applications using React’s latest features.',
          ),
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
                {
                  content: 'Create project directory and generate palette',
                  status: 'completed',
                  priority: 'high',
                },
                {
                  content: 'Build the portfolio HTML with full design system',
                  status: 'in_progress',
                  priority: 'high',
                },
                {
                  content: 'Preview the site via static server',
                  status: 'pending',
                  priority: 'high',
                },
                {
                  content: 'Playwright QA screenshots at desktop + mobile',
                  status: 'pending',
                  priority: 'medium',
                },
                {
                  content: 'Polish and fix any issues found in QA',
                  status: 'pending',
                  priority: 'medium',
                },
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
                  question:
                    'What kind of site are you looking for? Give me a quick description and I’ll run with it.',
                  options: [
                    {
                      label: 'Personal / portfolio',
                      description: 'A simple personal landing page, portfolio, or bio site',
                    },
                    {
                      label: 'Small business / brand',
                      description: 'A landing page for a brand, product, or small business',
                    },
                    {
                      label: 'Fun / experimental',
                      description: 'A playful or experimental micro-site',
                    },
                    {
                      label: 'Dashboard / tool',
                      description: 'A small web app, dashboard, or utility tool',
                    },
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
  {
    title: 'Show (output viewer)',
    rows: [
      {
        label: 'show (markdown)',
        node: part(
          'show',
          done(
            {
              type: 'markdown',
              title: 'Launch plan',
              content:
                '# Launch plan\n\n## This week\n\n- Ship the new pricing page\n- Wire up the checkout flow\n- QA on mobile + desktop\n\n## Next week\n\n1. Announcement post\n2. Email the waitlist\n3. Monitor conversion\n\n> The actions panel should stretch this content to the full height of the panel, with its own internal scroll.\n\n```ts\nexport const ready = true;\n```\n',
            },
            '',
          ),
        ),
      },
      {
        label: 'show (code)',
        node: part(
          'show',
          done(
            {
              type: 'code',
              title: 'server.ts',
              language: 'typescript',
              content:
                "import { serve } from 'bun';\n\nserve({\n  port: 3000,\n  fetch(req) {\n    const url = new URL(req.url);\n    if (url.pathname === '/health') return new Response('ok');\n    return new Response('Hello, Kortix', {\n      headers: { 'content-type': 'text/plain' },\n    });\n  },\n});\n",
            },
            '',
          ),
        ),
      },
      {
        label: 'show (url)',
        node: part(
          'show',
          done(
            {
              type: 'url',
              title: 'Kortix',
              description: 'Your AI workforce, in one place.',
              url: 'https://kortix.com',
            },
            '',
          ),
        ),
      },
      {
        label: 'show (error)',
        node: part(
          'show',
          done(
            {
              type: 'error',
              title: 'Build failed',
              content: 'Error: Cannot find module "@/lib/missing"\n  at /workspace/src/app.ts:3:1',
            },
            '',
          ),
        ),
      },
      {
        label: 'show (carousel pills)',
        node: part(
          'show',
          done(
            {
              items: [
                { type: 'url', url: 'http://localhost:3000' },
                { type: 'file', path: '/workspace/reports/q3-summary.pdf' },
                { type: 'file', path: '/workspace/decks/launch-deck.pptx' },
                { type: 'file', path: '/workspace/docs/contract.docx' },
                { type: 'file', path: '/workspace/data/metrics.xlsx' },
                { type: 'file', path: '/workspace/site/index.html' },
                { type: 'file', path: '/workspace/src/components/app.tsx' },
              ],
            },
            '',
          ),
        ),
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Easy-mode fixture — a plausible non-technical task: "look into how our
// competitors price their plans, write it up, and make a cover image."
// Exercises: grouping (6 consecutive reads → one step, 3 searches + 2 fetches
// → one mixed step), a `write` (Outputs), `read`s (Context files), a web
// search + fetch (Context web sources, incl. real, favicon-resolvable
// domains), a running step, an errored step, and a `show` call whose only
// input is a raw sandbox path (Easy mode must never render that path — see
// the `show` row in Progress, which narrates it by basename instead).
// ---------------------------------------------------------------------------
const PRICING_REPORT_CONTENT = `# Pricing comparison

## Acme Corp

- Starter: $12/mo — 3 seats, basic support
- Growth: $39/mo — 10 seats, priority support
- Enterprise: custom pricing, SSO + SLA

## Globex Cloud

- Basic: $9/mo — 5 seats
- Team: $29/mo — unlimited seats, no SSO
- Enterprise: custom pricing, SSO + dedicated CSM

## Takeaway

Both competitors gate SSO behind their top tier. Our Growth plan
undercuts Acme's equivalent tier by $10/mo while matching seat count.
`;

const EASY_PARTS = [
  // 1. Explore — 6 consecutive reads collapse into "Read 6 files".
  part('read', done({ filePath: '/workspace/notes/kickoff-brief.md' }, '<content/>')),
  part('read', done({ filePath: '/workspace/data/pricing-2026.csv' }, '<content/>')),
  part('read', done({ filePath: '/workspace/notes/competitor-list.md' }, '<content/>')),
  part('read', done({ filePath: '/workspace/docs/brand-guide.md' }, '<content/>')),
  part('read', done({ filePath: '/workspace/notes/customer-quotes.md' }, '<content/>')),
  part('read', done({ filePath: '/workspace/docs/outline.md' }, '<content/>')),

  // 2. Web — 3 searches + 2 fetches, same family, collapse into one mixed
  // step ("Searched and read 5 sources"); each stays distinct in Context's
  // "Web sources" bucket. The third search uses real, resolvable domains
  // (github.com/wikipedia.org/stackoverflow.com) rather than the fictional
  // acme.example.com/globex.example.com competitor sites above — those don't
  // exist, so Google's favicon service can only ever return the generic
  // globe fallback for them. Without at least one real domain, the
  // "Web sources" row favicons would be unverifiable — every row would look
  // the same regardless of whether real-favicon rendering actually works.
  part(
    'web_search',
    done(
      { query: 'Acme Corp pricing plans 2026' },
      JSON.stringify({
        query: 'Acme Corp pricing plans 2026',
        results: [
          { title: 'Acme Corp Pricing Plans', url: 'https://acme.example.com/pricing' },
        ],
      }),
    ),
  ),
  part(
    'web_search',
    done(
      { query: 'Globex Cloud pricing tiers comparison' },
      JSON.stringify({
        query: 'Globex Cloud pricing tiers comparison',
        results: [
          { title: 'Globex Cloud — Plans & Pricing', url: 'https://globex.example.com/plans' },
        ],
      }),
    ),
  ),
  part(
    'web_search',
    done(
      { query: 'SaaS pricing page best practices' },
      JSON.stringify({
        query: 'SaaS pricing page best practices',
        results: [
          {
            title: 'Pricing page examples · GitHub Topics',
            url: 'https://github.com/topics/pricing-page',
          },
          {
            title: 'Pricing strategies - Wikipedia',
            url: 'https://en.wikipedia.org/wiki/Pricing_strategies',
          },
          {
            title: 'What tier structure works best for a B2B SaaS product? - Stack Overflow',
            url: 'https://stackoverflow.com/questions/71234567/saas-pricing-tier-structure',
          },
        ],
      }),
    ),
  ),
  part(
    'webfetch',
    done(
      { url: 'https://acme.example.com/pricing', format: 'markdown' },
      '# Pricing\n\nStarter $12/mo · Growth $39/mo · Enterprise — talk to sales.',
    ),
  ),
  part(
    'webfetch',
    done(
      { url: 'https://globex.example.com/plans', format: 'markdown' },
      '# Plans\n\nBasic $9/mo · Team $29/mo · Enterprise — custom.',
    ),
  ),

  // 3. A hiccup along the way — its own errored step, never merged into the
  // web group above (different family) or the running step below (other
  // families sit between them).
  part(
    'bash',
    errored(
      { command: 'pip install matplotlib-extra', description: 'Install charting helper' },
      'ERROR: Could not find a version that satisfies the requirement matplotlib-extra\nERROR: No matching distribution found for matplotlib-extra',
    ),
  ),

  // 3b. Memory — a recall from an earlier session, its own step (different
  // family from the `run` step above and the `edit` step below, so it never
  // merges into either). Exercises the Memory badge + Brain glyph in Context
  // and the Progress stepper's memory family icon — without this, neither
  // could be verified against a real fixture.
  part(
    'memory_search',
    done(
      { query: 'competitor pricing notes' },
      JSON.stringify({
        query: 'competitor pricing notes',
        results: [
          {
            id: 'mem_204',
            type: 'note',
            source: 'ltm',
            confidence: 0.86,
            content:
              'User previously flagged that Acme undercuts on annual billing discounts — check before finalizing the comparison.',
          },
        ],
      }),
    ),
  ),

  // 4. write — its own step (Outputs card picks this up as a real file).
  part(
    'write',
    done(
      { filePath: '/workspace/reports/pricing-comparison.md', content: PRICING_REPORT_CONTENT },
      '',
    ),
  ),

  // 4b. A write that FAILED — must never appear in Outputs (see BLOCKER 3):
  // the file was never actually produced, so the card must not advertise it
  // as something the user can open.
  part(
    'write',
    errored(
      { filePath: '/workspace/reports/failed-draft.md' },
      'ENOSPC: no space left on device',
    ),
  ),

  // 5. create — image_gen, its own step (Outputs card, kind "image"). Uses a
  // locally-served asset as the direct URL so the tool view renders a real
  // image without needing a live sandbox.
  part(
    'image_gen',
    done(
      { action: 'generate', prompt: 'Minimal editorial cover image for a pricing comparison report' },
      JSON.stringify({
        path: '/workspace/outputs/pricing-cover.png',
        replicate_url: '/wallpapers/nebula-dark.jpg',
      }),
    ),
  ),

  // 6. show — previews the finished report with only a raw sandbox path in
  // its input, no title. This is the exact shape that used to leak straight
  // through to "Showed you /workspace/reports/pricing-comparison.html" (see
  // BLOCKER 2 — a raw path/URL must never reach a non-technical user); the
  // fixed narration must show a basename instead ("Showed you
  // pricing-comparison.html").
  part(
    'show',
    done(
      { type: 'file', path: '/workspace/reports/pricing-comparison.html' },
      '',
    ),
  ),

  // 7. Still going — the run isn't finished, so Progress shows the shimmer.
  part('bash', running({ command: 'pnpm exec pandoc pricing-comparison.md -o pricing-comparison.pdf' })),
];

const EASY_MESSAGES: MessageWithParts[] = [
  {
    info: { id: 'm_easy', role: 'assistant' },
    parts: EASY_PARTS,
  } as any,
];

// A run that has only just started: no tool calls yet at all. Exercises the
// Outputs/Context cards' EMPTY states (soft placeholder art + one plain
// sentence) — the main fixture above always has content in both, so without
// this the empty state would ship unverified.
const EMPTY_MESSAGES: MessageWithParts[] = [
  {
    info: { id: 'm_empty', role: 'assistant' },
    parts: [],
  } as any,
];

export default function DebugToolsPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(true);
  const focusToolCall = useKortixComputerStore((s) => s.focusToolCall);

  return (
    <div className="bg-background text-foreground min-h-screen w-full">
      <div className="border-border/60 bg-background/80 sticky top-0 z-10 flex items-center justify-between border-b px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-base font-semibold">
            {tHardcodedUi.raw('appDebugToolsPage.line268JsxTextToolRenderers')}
          </h1>
          <p className="text-muted-foreground text-xs">
            {tHardcodedUi.raw(
              'appDebugToolsPage.line270JsxTextDebugToolsVisualHarnessForSessionToolChrome',
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="border-border bg-card hover:bg-muted rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
        >
          {open ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {/* Easy-mode panel preview — the non-technical card home, and the
          Advanced stepper beside it fed the exact same fixture, so both
          panel modes are eyeball-comparable side by side without needing a
          logged-in session or `panelMode` preference. */}
      <div className="mx-auto w-full max-w-5xl px-6 pt-10">
        <h2 className="text-muted-foreground mb-4 text-xs font-semibold tracking-wide uppercase">
          Easy mode vs. Advanced
        </h2>
        <div className="flex flex-wrap items-start gap-6">
          <div>
            <div className="text-muted-foreground/60 mb-2 font-mono text-xs tracking-wide uppercase">
              Easy
            </div>
            <div className="border-border bg-card h-[640px] w-[420px] overflow-hidden rounded-2xl border">
              <EasyPanel sessionId="debug-easy" messages={EASY_MESSAGES} />
            </div>
          </div>
          <div>
            <div className="text-muted-foreground/60 mb-2 font-mono text-xs tracking-wide uppercase">
              Advanced
            </div>
            <div className="border-border bg-card h-[640px] w-[420px] overflow-hidden rounded-2xl border">
              <AdvancedPanel sessionId="debug-easy" messages={EASY_MESSAGES} />
            </div>
          </div>
          <div>
            <div className="text-muted-foreground/60 mb-2 font-mono text-xs tracking-wide uppercase">
              Easy — empty (no tool calls yet)
            </div>
            <div className="border-border bg-card h-[640px] w-[420px] overflow-hidden rounded-2xl border">
              <EasyPanel sessionId="debug-easy-empty" messages={EMPTY_MESSAGES} />
            </div>
          </div>
        </div>
      </div>

      {/* FileViewer fixture — /debug/tools has no live sandbox, so FilePreview's
          fetch always fails and the viewer can never be reached through Outputs.
          Render it directly, three times, one per toolbar shape:
            - markdown  → file icon + name, rendered document, NO toggle
            - html      → Preview/Source toggle at the far left (the only type
                          whose rendered form and source are both worth seeing)
            - other     → file icon + name, source only, NO toggle
          All three share the same right-hand actions. */}
      <div className="mx-auto w-full max-w-6xl px-6 pt-10">
        <h2 className="text-muted-foreground mb-4 text-xs font-semibold tracking-wide uppercase">
          FileViewer
        </h2>
        <div className="flex flex-wrap items-start gap-6">
          <div>
            <div className="text-muted-foreground/60 mb-2 font-mono text-xs tracking-wide uppercase">
              markdown — no toggle
            </div>
            <div className="border-border bg-popover h-[560px] w-[520px] overflow-hidden rounded-2xl border">
              <FileViewer
                content={MARKDOWN_PREVIEW_CONTENT}
                fileName="jay-suthar.md"
                path="/workspace/jay-suthar.md"
                onClose={() => {}}
              />
            </div>
          </div>
          <div>
            <div className="text-muted-foreground/60 mb-2 font-mono text-xs tracking-wide uppercase">
              html — preview / source toggle
            </div>
            <div className="border-border bg-popover h-[560px] w-[520px] overflow-hidden rounded-2xl border">
              <FileViewer
                content={HTML_PREVIEW_CONTENT}
                fileName="report.html"
                path="/workspace/report.html"
                onClose={() => {}}
              />
            </div>
          </div>
          <div>
            <div className="text-muted-foreground/60 mb-2 font-mono text-xs tracking-wide uppercase">
              other — source only
            </div>
            <div className="border-border bg-popover h-[560px] w-[520px] overflow-hidden rounded-2xl border">
              <FileViewer
                content={TS_SOURCE_CONTENT}
                fileName="example.ts"
                path="/workspace/example.ts"
                onClose={() => {}}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Side-panel Actions view preview — the focused navigator that reuses
          the same ToolPartRenderer handlers, fed the mock tool parts. */}
      <div className="mx-auto w-full max-w-3xl px-6 pt-10">
        <h2 className="text-muted-foreground mb-4 text-xs font-semibold tracking-wide uppercase">
          {tHardcodedUi.raw('appDebugToolsPage.line286JsxTextSidePanelActions')}
        </h2>
        <div className="border-border bg-card h-[560px] w-full overflow-hidden rounded-2xl border">
          <AdvancedPanel
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
        <h2 className="text-muted-foreground mb-4 text-xs font-semibold tracking-wide uppercase">
          {tHardcodedUi.raw('appDebugToolsPage.line305JsxTextSidePanelChanges')}
        </h2>
        <div className="border-border bg-card h-[420px] w-full overflow-hidden rounded-2xl border">
          <SessionFilesPanel />
        </div>
      </div>

      {/* Side-panel Files view preview — the in-sandbox explorer (the same
          /files FileExplorerPage, in preview mode). Without a live sandbox it
          shows its "server not reachable" empty state. */}
      <div className="mx-auto w-full max-w-3xl px-6 pt-10">
        <h2 className="text-muted-foreground mb-4 text-xs font-semibold tracking-wide uppercase">
          {tI18nHardcoded.raw('autoAppSystemDebugToolsPageJsxTextSidePanelFileseba2e222')}
        </h2>
        <div className="border-border bg-card h-[420px] w-full overflow-hidden rounded-2xl border">
          <SessionFilesExplorer />
        </div>
      </div>

      {/* Inline chat rows — clicking one focuses the panel above (the same
          chat → side-panel flow), via ToolActivateContext + focusToolCall. */}
      <ToolActivateContext.Provider value={(callID) => focusToolCall(callID)}>
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <p className="text-muted-foreground/60 mb-6 text-xs">
            {tHardcodedUi.raw('appDebugToolsPage.line306JsxTextClickAnyRowBelowItOpensInThe')}
          </p>
          {GROUPS.map((group) => (
            <section key={group.title} className="mb-12">
              <h2 className="text-muted-foreground mb-4 text-xs font-semibold tracking-wide uppercase">
                {group.title}
              </h2>
              <div className="space-y-3">
                {group.rows.map((row) => (
                  <div key={row.label}>
                    <div className="text-muted-foreground/50 mb-1 font-mono text-xs tracking-wide uppercase">
                      {row.label}
                    </div>
                    <div className="border-border/40 bg-card/30 rounded-2xl border px-4 py-3">
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
