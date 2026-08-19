'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { ToolActivateContext } from '@/features/session/tool/shared/infrastructure';
import { ActivityBurst } from '@/features/session/turn/activity-burst';
import { PlanCard } from '@/features/session/turn/plan-card';
import { UserMessage } from '@/features/session/turn/user-message';
import type { MessageWithParts, Part } from '@/ui';
import { beginOptimisticSend } from '@kortix/sdk/react';

/**
 * /debug/turn
 *
 * Companion to /debug/tools. That page inspects individual tool renderers;
 * this one inspects the assembled turn — the burst collapse lifecycle, title
 * generation, the plumbing sub-disclosure, the user card, and the plan card.
 *
 * Exists because the things most likely to break here are invisible to unit
 * tests: collapsed height, Tailwind group scoping, caret rotation, dark/light
 * contrast. Driving a real session needs a provisioned sandbox; this needs
 * nothing. Not linked from anywhere — just hit /debug/turn.
 */

// ---------------------------------------------------------------------------
// Fixtures — loose typing on purpose, same convention as /debug/tools.
// ---------------------------------------------------------------------------
let n = 0;
const nextId = () => `prt_dbg_${(n += 1)}`;

function tool(name: string, input: Record<string, unknown>, ms = 1200, output = ''): Part {
  const id = nextId();
  return {
    id,
    messageID: 'msg_dbg',
    sessionID: 'ses_dbg',
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: {
      status: 'completed',
      input,
      output,
      time: { start: 1_000_000, end: 1_000_000 + ms },
    },
  } as unknown as Part;
}

/**
 * Real shape `parseWebSearchOutput` expects — one query, real sources.
 * Stringified: tool output always arrives from the server as a string, and
 * `partOutput`/`isErrorOutput` assume that (a raw object here breaks with
 * "raw.replace is not a function").
 */
const SEARCH_OUTPUT = JSON.stringify({
  results: [
    {
      query: 'postgres advisory lock leader election',
      results: [
        {
          title: 'PostgreSQL: Documentation: Advisory Locks',
          url: 'https://www.postgresql.org/docs/current/explicit-locking.html',
        },
        {
          title: 'Leader election with Postgres advisory locks',
          url: 'https://leontrolski.github.io/pg-leader.html',
        },
        {
          title: 'Distributed locks with Postgres',
          url: 'https://www.citusdata.com/blog/2019/08/09/postgres-advisory-locks/',
        },
      ],
    },
  ],
});

function runningTool(name: string, input: Record<string, unknown>): Part {
  const id = nextId();
  return {
    id,
    messageID: 'msg_dbg',
    sessionID: 'ses_dbg',
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'running', input, time: { start: 1_000_000 } },
  } as unknown as Part;
}

function reasoning(text: string, done = true): Part {
  return {
    id: nextId(),
    messageID: 'msg_dbg',
    sessionID: 'ses_dbg',
    type: 'reasoning',
    text,
    time: done ? { start: 1_000_000, end: 1_000_400 } : { start: 1_000_000 },
  } as unknown as Part;
}

/** Long enough (>4000 chars) to route through RawOutputBlock rather than the
 *  inline markdown fallback, and unambiguously markdown so it renders as
 *  markdown rather than as monospace punctuation. */
const MARKDOWN_OUTPUT = [
  '## Advisory lock audit',
  '',
  'Checked every `pg_advisory_lock` call site against the worker pool.',
  '',
  '1. `jobs-queue.ts` takes a **session-scoped** lock and releases on finally.',
  '2. `enrichment-worker.ts` takes a transaction lock — released on commit.',
  '3. No call site holds a lock across an `await` on a network call.',
  '',
  'See [the Postgres docs](https://www.postgresql.org/docs/current/explicit-locking.html).',
  '',
  '```sql',
  'SELECT pg_try_advisory_lock(hashtext($1));',
  '```',
  '',
  'Remaining risk: a worker killed between `lock` and `commit` holds the lock',
  'until its backend disconnects.',
  '',
  `<!-- padding to push past the 4000-char RawOutputBlock threshold -->\n${'Verified against the live pool. '.repeat(140)}`,
].join('\n');

/** Not markdown — a stack trace must stay in the monospace block. */
const RAW_LOG_OUTPUT = `Traceback (most recent call last):
  File "/workspace/src/enrichment-worker.py", line 88, in run
    lock = acquire(conn, key)
  File "/workspace/src/locks.py", line 31, in acquire
    raise LockTimeout(f"timed out after {timeout}s")
LockTimeout: timed out after 30s
${'  at worker.tick (/workspace/src/enrichment-worker.py:120)\n'.repeat(90)}`;

/**
 * A fetched page, markdown, comfortably UNDER 4000 chars — the case that fell
 * through to a bare div before the shared output card existed.
 */
const SHORT_PAGE_OUTPUT = [
  '# Jay Suthar',
  '',
  'Mumbai, IN',
  '',
  '[tools](https://sutharjay.com/tools)',
  '',
  'I design and engineer exceptional interfaces with a focus on usability,',
  'clarity, and purposeful interaction.',
  '',
  'Building [actrun.ai](https://actrun.ai) — AI agents that run your workflows.',
].join('\n');

/** parseFilePaths only accepts lines starting `/`, `./` or `~`. */
const GLOB_OUTPUT = [
  '/workspace/src/features/session/turn/activity-burst.tsx',
  '/workspace/src/features/session/turn/activity-step.tsx',
  '/workspace/src/features/session/turn/merge-steps.ts',
  '/workspace/src/features/session/tool/shared/result-card.tsx',
  '/workspace/src/components/ui/chain-of-thought.tsx',
].join('\n');

/** apply_patch reads its files off metadata, not output. */
const PATCH_FILES = [
  {
    relativePath: 'src/features/session/tool/shared/result-card.tsx',
    type: 'add',
    additions: 52,
    deletions: 0,
    patch: '+ export function ToolResultCard() {}',
  },
  {
    relativePath: 'src/features/session/tool/tools/glob-tool.tsx',
    type: 'update',
    additions: 6,
    deletions: 4,
    patch: '- <div data-scrollable>\n+ <ToolResultCard>',
  },
  {
    relativePath: 'src/features/session/tool/tools/legacy-file-list.tsx',
    type: 'delete',
    additions: 0,
    deletions: 31,
  },
];

function patchTool(): Part {
  const id = nextId();
  return {
    id,
    messageID: 'msg_dbg',
    sessionID: 'ses_dbg',
    type: 'tool',
    tool: 'apply_patch',
    callID: `call_${id}`,
    state: {
      status: 'completed',
      input: {},
      output: '',
      metadata: { files: PATCH_FILES },
      time: { start: 1_000_000, end: 1_000_900 },
    },
  } as unknown as Part;
}

/**
 * Shape `parseScrapeOutput` expects — `{ results: [{ url, success, title,
 * content }] }`, stringified like every other tool output. One failure in the
 * set so the destructive glyph on a row is covered too.
 */
const SCRAPE_URLS = [
  'https://www.postgresql.org/docs/current/explicit-locking.html',
  'https://sutharjay.com',
  'https://example.invalid/missing',
];

const SCRAPE_OUTPUT = JSON.stringify({
  total: 3,
  successful: 2,
  failed: 1,
  results: [
    {
      url: SCRAPE_URLS[0],
      success: true,
      title: 'PostgreSQL: Documentation: Explicit Locking',
      content: [
        '## 13.3. Explicit Locking',
        '',
        'PostgreSQL provides various lock modes to control concurrent access to',
        'data in tables. Advisory locks are allocated by the application rather',
        'than by the system, and are released either at transaction end or on an',
        'explicit unlock call.',
        '',
        '```sql',
        'SELECT pg_try_advisory_lock(hashtext($1));',
        '```',
      ].join('\n'),
    },
    {
      url: SCRAPE_URLS[1],
      success: true,
      title: 'Jay Suthar',
      content: '# Jay Suthar\n\nMumbai, IN\n\nI design and engineer exceptional interfaces.',
    },
    {
      url: SCRAPE_URLS[2],
      success: false,
      error: 'DNS lookup failed for example.invalid (ENOTFOUND).',
    },
  ],
});

/** Plain error + stack trace → the summary/disclosure branch of ToolError. */
const ERROR_WITH_TRACE = `Error: ENOENT: no such file or directory, open '/workspace/src/missing.ts'
Traceback (most recent call last):
  File "/workspace/src/loader.py", line 42, in load
    return open(path).read()
  File "/workspace/src/loader.py", line 51, in read
    raise FileNotFoundError(path)
FileNotFoundError: /workspace/src/missing.ts`;

/** Every URL in the batch dead → a full failure, not a partial. */
const SCRAPE_ALL_FAILED = JSON.stringify({
  total: 1,
  successful: 0,
  failed: 1,
  results: [
    {
      url: SCRAPE_URLS[2],
      success: false,
      error: 'DNS lookup failed for example.invalid (ENOTFOUND).',
    },
  ],
});

/** A tool call that THREW, as opposed to one that returned its error. */
function erroredTool(name: string, input: Record<string, unknown>, error: string): Part {
  const id = nextId();
  return {
    id,
    messageID: 'msg_dbg',
    sessionID: 'ses_dbg',
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'error', input, error, time: { start: 1_000_000, end: 1_000_900 } },
  } as unknown as Part;
}

const BURSTS: Array<{ label: string; parts: Part[]; working: boolean }> = [
  {
    // The three shapes side by side. They used to render as three different
    // things — only the thrown call got a warning mark, while the two that
    // came back `completed` kept the tool's own globe and the chain still
    // closed on "Done". Same failure, so they must read the same.
    label: 'failure · thrown vs returned vs half-landed, and the cap that follows',
    working: false,
    parts: [
      erroredTool(
        'bash',
        { command: 'pnpm build' },
        'Error: Command failed with exit code 1: pnpm build',
      ),
      // status: completed. The output IS the error.
      tool(
        'scrape_webpage',
        { urls: [SCRAPE_URLS[2]] },
        900,
        'Error: DNS lookup failed for example.invalid (ENOTFOUND).',
      ),
      // status: completed, batch contract, every item dead → red.
      tool('scrape_webpage', { urls: [SCRAPE_URLS[2]] }, 900, SCRAPE_ALL_FAILED),
      // status: completed, 2 of 3 landed → amber, not red.
      tool('scrape_webpage', { urls: SCRAPE_URLS }, 3100, SCRAPE_OUTPUT),
    ],
  },
  {
    label: 'errors · summary + stack trace, inside the same card',
    working: false,
    parts: [tool('file_probe', { path: '/workspace/src/missing.ts' }, 200, ERROR_WITH_TRACE)],
  },
  {
    label: 'result cards · glob + apply_patch share the search list shape',
    working: false,
    parts: [
      // 1. Specific pattern → the pattern is the label.
      tool('glob', { pattern: '**/*.tsx', path: '/workspace/src' }, 400, GLOB_OUTPUT),
      // 2. Catch-all pattern → falls back to the searched path, NOT `*`.
      //    Also proves the path is reported as-is, not via getDirectory, which
      //    would have named `/workspace` here.
      tool('glob', { pattern: '*', path: '/workspace/src' }, 300, GLOB_OUTPUT),
      // 3. Catch-all with no path at all → the prose fallback.
      tool('glob', { pattern: '**/*' }, 300, GLOB_OUTPUT),
      patchTool(),
    ],
  },
  {
    label: 'raw output · markdown renders, stack trace stays monospace',
    working: false,
    // Unregistered tool names on purpose: they fall through to GenericTool →
    // ToolOutputFallback → RawOutputBlock, which is the block under test. A
    // tool with its own renderer (bash, read) never reaches it.
    parts: [
      tool('audit_report', { scope: 'locks' }, 2100, MARKDOWN_OUTPUT),
      tool('worker_probe', { target: 'enrich' }, 1200, RAW_LOG_OUTPUT),
      // SHORT and non-JSON: under the 4000-char bar, so it takes the branch
      // that used to skip RawOutputBlock entirely and render naked text. This
      // is the exact shape a web_fetch of a page returns.
      tool('page_fetch', { url: 'sutharjay.com', format: 'markdown' }, 700, SHORT_PAGE_OUTPUT),
    ],
  },
  {
    label: 'bash · multi-line pipeline, highlighted, output under a hairline',
    working: false,
    parts: [
      tool(
        'bash',
        {
          command: [
            'curl -s "https://api.github.com/users/sutharjay1/repos?per_page=100&sort=pushed" |',
            'python3 -c "',
            'import json,sys',
            'd=json.load(sys.stdin)',
            'for r in d:',
            "    print(f\\\"{r['name']} | {r['language']} | {r['pushed_at'][:10]}\\\")\"",
          ].join('\n'),
        },
        2400,
        'suna | TypeScript | 2026-07-31\nkortix-sdk | TypeScript | 2026-07-29\ndotfiles | Shell | 2026-06-02',
      ),
      tool('bash', { command: 'pnpm build' }, 8200),
    ],
  },
  {
    label: 'settled · reasoning supplies the title',
    working: false,
    parts: [
      // Three consecutive fragments plus a memory write wedged between two of
      // them — must collapse to ONE thinking row, and the memory must not
      // split the run or appear at all.
      reasoning('**Audited worker registration and quota limits.**'),
      tool('memory', {}),
      reasoning('Checked how workers register and whether leader election races.'),
      reasoning('Quota enforcement looked fine under the current ceiling.'),
      tool('read', { filePath: '/workspace/src/jobs-queue.ts' }),
      tool('read', { filePath: '/workspace/src/enrichment-worker.ts' }),
      tool('web_search', { query: 'postgres advisory lock leader election' }, 1400, SEARCH_OUTPUT),
      tool(
        'web_fetch',
        { url: 'https://www.postgresql.org/docs/current/explicit-locking.html' },
        900,
      ),
      tool('bash', { command: 'bun test enrichment' }, 3400),
      tool('dcp_compress', {}),
      tool('get_mem', {}),
    ],
  },
  {
    label: 'settled · title composed from verb counts',
    working: false,
    parts: [
      tool('read', { filePath: '/workspace/a.ts' }),
      tool('read', { filePath: '/workspace/b.ts' }),
      tool('bash', { command: 'pnpm build' }, 8200),
    ],
  },
  {
    label: 'streaming · opens itself, live indicator',
    working: true,
    parts: [
      reasoning('Working through the retry path', false),
      tool('read', { filePath: '/workspace/page-fetch.ts' }),
      runningTool('bash', { command: 'bun test --watch' }),
    ],
  },
  {
    label: 'clause cap · three clauses then +N more',
    working: false,
    parts: [
      tool('read', { filePath: '/workspace/a.ts' }),
      tool('bash', { command: 'ls' }),
      tool('web_search', { query: 'x' }),
      tool('write', { filePath: '/workspace/out.md' }),
      tool('list', { path: '/workspace' }),
    ],
  },
  {
    label: 'plumbing only · renders NOTHING — no rows means no burst',
    working: false,
    parts: [tool('dcp_prune', {}), tool('context_info', {})],
  },
  {
    label: 'icon mix · read/bash/write vs glob/grep/list',
    working: false,
    parts: [
      tool('read', { filePath: '/workspace/a.ts' }),
      tool('glob', { pattern: '**/*.ts' }),
      tool('bash', { command: 'ls -la' }),
      tool('grep', { pattern: 'TODO' }),
      tool('write', { filePath: '/workspace/out.md' }),
      tool('list', { path: '/workspace/src' }),
    ],
  },
  {
    // Every one of these used to render its body as a bare `px-3 py-2` div: no
    // edge, so the content ran straight into the chain rail beside it while
    // bash — the same family of tool — sat in a hairlined card. This burst
    // exists so that divergence is visible the moment it comes back. /debug/tools
    // cannot show it: that page binds `ToolActivateContext`, so `BasicTool`
    // returns an `ActivatableToolRow` and the body never renders inline at all.
    label: 'result cards · pty/list/agent_spawn bodies must match bash',
    working: false,
    parts: [
      tool('bash', { command: 'pnpm dev' }, 900, 'ready on :3000'),
      tool(
        'pty_spawn',
        { command: 'pnpm dev', title: 'Dev server' },
        800,
        '<pty_spawned>\nID: pty_4f2a\nTitle: Dev server\nCommand: pnpm dev\nStatus: running\nPID: 48213\nWorkdir: /workspace/apps/web\n</pty_spawned>',
      ),
      tool(
        'pty_read',
        { id: 'pty_4f2a' },
        300,
        '<pty_output id="pty_4f2a" status="running">\n00001| $ pnpm dev\n00002| ▲ Next.js 16.0.0\n00003| - Local:  http://localhost:3000\n00004| ✓ Ready in 1.2s\n(End of buffer — 4 lines total)\n</pty_output>',
      ),
      tool('pty_write', { id: 'pty_4f2a', input: 'rs\n' }, 120, 'ok'),
      tool('pty_kill', { id: 'pty_4f2a' }, 150, 'Process pty_4f2a terminated.'),
      // Empty directory: the "is empty" answer is carded like any other result.
      tool('list', { path: '/workspace/empty' }, 200, 'No files found'),
      // No child session here, so this exercises the verification-only branch —
      // the one that used to render as a bare line of text under the row.
      tool(
        'agent_spawn',
        {
          title: 'Draft the pricing comparison report',
          verification_condition:
            'The report exists at /workspace/reports/pricing-comparison.md and covers 3 competitors.',
        },
        4200,
        'Report written to /workspace/reports/pricing-comparison.md',
      ),
      // Three pages incl. one failure: proves the rows are flat inside ONE card
      // (they used to carry a rounded border each) and that the hairline still
      // separates a result from the next once its content is expanded.
      tool('scrape_webpage', { urls: SCRAPE_URLS }, 3100, SCRAPE_OUTPUT),
    ],
  },
];

const userMessage = {
  info: {
    id: 'msg_dbg_user',
    sessionID: 'ses_dbg',
    role: 'user',
    time: { created: 1_000_000 },
  },
  parts: [
    {
      id: 'prt_dbg_user',
      messageID: 'msg_dbg_user',
      sessionID: 'ses_dbg',
      type: 'text',
      text: 'If inside tooltip content there is a `kbd` data slot, the right padding needs to collapse so the key cap sits flush. Check how the other slots handle it and keep it consistent.',
    },
  ],
} as unknown as MessageWithParts;

/**
 * The reported multi-attachment case: 11 screenshots + 4 documents + a two-word
 * message. Uploads reach the transcript as `<file …>` tags inside the text
 * (uploaded-file-refs.ts), which `parseFileReferences` strips back out — so
 * this fixture is byte-shaped like a real send, not a hand-built props object.
 *
 * None of these paths resolve here, which is the point: it also exercises the
 * unresolvable-image fallback that used to render as a blank box.
 */
const fileTag = (path: string, mime: string, filename: string) =>
  `<file path="${path}" mime="${mime}" filename="${filename}">\nThis file has been uploaded and is available at the path above.\n</file>`;

const MANY_ATTACHMENT_TEXT = [
  'HIII',
  '',
  ...Array.from({ length: 11 }, (_, i) =>
    fileTag(
      `/workspace/uploads/Screenshot_2026-08-01_at_3.4${i}.12_PM.png`,
      'image/png',
      `Screenshot 2026-08-01 at 3.4${i}.12 PM.png`,
    ),
  ),
  fileTag('/workspace/uploads/plan.md', 'text/markdown', 'plan.md'),
  fileTag('/workspace/uploads/DESIGN-framer.md', 'text/markdown', 'DESIGN-framer.md'),
  fileTag('/workspace/uploads/Receipt-2199-5561.pdf', 'application/pdf', 'Receipt-2199-5561.pdf'),
  fileTag(
    '/workspace/uploads/AdmitCard-260411128971.pdf',
    'application/pdf',
    'AdmitCard-260411128971.pdf',
  ),
].join('\n');

const manyAttachmentMessage = {
  info: {
    id: 'msg_dbg_attach',
    sessionID: 'ses_dbg',
    role: 'user',
    time: { created: 1_000_001 },
  },
  parts: [
    {
      id: 'prt_dbg_attach',
      messageID: 'msg_dbg_attach',
      sessionID: 'ses_dbg',
      type: 'text',
      text: MANY_ATTACHMENT_TEXT,
    },
  ],
} as unknown as MessageWithParts;

const fewAttachmentMessage = {
  info: {
    id: 'msg_dbg_attach_few',
    sessionID: 'ses_dbg',
    role: 'user',
    time: { created: 1_000_002 },
  },
  parts: [
    {
      id: 'prt_dbg_attach_few',
      messageID: 'msg_dbg_attach_few',
      sessionID: 'ses_dbg',
      type: 'text',
      text: [
        'can you look at these',
        '',
        fileTag('/workspace/uploads/shot.png', 'image/png', 'shot.png'),
        fileTag('/workspace/uploads/notes.md', 'text/markdown', 'notes.md'),
      ].join('\n'),
    },
  ],
} as unknown as MessageWithParts;

/** Same attachments, but registered with the store as an unconfirmed send —
 *  which is exactly what `isOptimisticMessage` keys the uploading state off. */
const uploadingMessage = {
  info: {
    id: 'msg_dbg_uploading',
    sessionID: 'ses_dbg',
    role: 'user',
    time: { created: 1_000_003 },
  },
  parts: [
    {
      id: 'prt_dbg_uploading',
      messageID: 'msg_dbg_uploading',
      sessionID: 'ses_dbg',
      type: 'text',
      text: MANY_ATTACHMENT_TEXT,
    },
  ],
} as unknown as MessageWithParts;

const TODOS = [
  { content: 'Read the enrichment worker', status: 'completed' },
  { content: 'Map the retry and rate-limit paths', status: 'completed' },
  { content: 'Audit worker registration', status: 'in_progress' },
  { content: 'Check quota enforcement', status: 'pending' },
  { content: 'Write the hardening plan', status: 'pending' },
];

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section data-case={label} className="border-border/40 border-b py-6">
      <p className="text-muted-foreground/60 mb-3 font-mono text-xs">{label}</p>
      {children}
    </section>
  );
}

export default function DebugTurnPage() {
  const [dark, setDark] = useState(true);
  const [activateCount, setActivateCount] = useState(0);
  // Stable identity: an inline arrow in `value` would re-render every
  // context consumer on each render of this page.
  const onToolActivate = useCallback(() => setActivateCount((n) => n + 1), []);

  // Mark the uploading fixture as an in-flight send so the tiles render their
  // spinner. Mirrors what `beginOptimisticSend` does on a real send.
  useEffect(() => {
    beginOptimisticSend('ses_dbg', 'msg_dbg_uploading', MANY_ATTACHMENT_TEXT);
  }, []);
  const [qc] = useState(() => {
    const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // PlanCard reads this exact key; the todo.updated SSE handler writes it.
    c.setQueryData(['opencode', 'session-todo', 'ses_dbg'], TODOS);
    return c;
  });

  // next-themes puts the class on <html>, so drive that rather than a wrapper.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  return (
    <QueryClientProvider client={qc}>
      <div className="bg-background text-foreground min-h-screen">
        <div className="mx-auto w-full max-w-3xl px-6 py-8">
          <button
            id="theme-toggle"
            type="button"
            onClick={() => setDark((d) => !d)}
            className="border-border text-muted-foreground mb-6 rounded-md border px-3 py-1.5 text-xs"
          >
            theme: {dark ? 'dark' : 'light'}
          </button>

          <p id="activate-count" className="text-muted-foreground/60 mb-6 font-mono text-xs">
            side-panel activations: {activateCount}
          </p>

          <Section label="user message · no plan → bubble hugs its text, right-aligned">
            <UserMessage message={userMessage} sessionId="ses_dbg" ownsPlan={false} />
          </Section>

          <Section label="user message · owns the plan → spans the column, PlanCard inside">
            <UserMessage message={userMessage} sessionId="ses_dbg" ownsPlan />
          </Section>

          <Section label="user message · UPLOADING → every tile spins, name still readable">
            <UserMessage message={uploadingMessage} sessionId="ses_dbg" ownsPlan={false} />
          </Section>

          <Section label="user message · 15 attachments → square tiles wrap 4-up, capped at 8 with +7">
            <UserMessage message={manyAttachmentMessage} sessionId="ses_dbg" ownsPlan={false} />
          </Section>

          <Section label="user message · 2 attachments → same square tile, no cap">
            <UserMessage message={fewAttachmentMessage} sessionId="ses_dbg" ownsPlan={false} />
          </Section>

          <Section label="plan card · 2 of 5, in-progress row visible">
            <PlanCard sessionId="ses_dbg" />
          </Section>

          {/*
            Every burst below is rendered under a REAL, non-null
            ToolActivateContext — exactly the condition session-chat.tsx
            creates in production. If ActivityBurst's local override didn't
            work, every click on a tool row would increment this counter
            instead of expanding the row inline.
          */}
          <ToolActivateContext.Provider value={onToolActivate}>
            {BURSTS.map((b) => (
              <Section key={b.label} label={b.label}>
                <ActivityBurst
                  parts={b.parts}
                  sessionId="ses_dbg"
                  working={b.working}
                  disableNavigation
                />
              </Section>
            ))}
          </ToolActivateContext.Provider>
        </div>
      </div>
    </QueryClientProvider>
  );
}
