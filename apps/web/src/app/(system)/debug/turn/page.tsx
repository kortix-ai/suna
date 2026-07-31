'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { ActivityBurst } from '@/features/session/turn/activity-burst';
import { PlanCard } from '@/features/session/turn/plan-card';
import { UserMessage } from '@/features/session/turn/user-message';
import type { MessageWithParts, Part } from '@/ui';

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

function tool(name: string, input: Record<string, unknown>, ms = 1200): Part {
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
      output: '',
      time: { start: 1_000_000, end: 1_000_000 + ms },
    },
  } as unknown as Part;
}

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

const BURSTS: Array<{ label: string; parts: Part[]; working: boolean }> = [
  {
    label: 'settled · reasoning supplies the title',
    working: false,
    parts: [
      reasoning(
        '**Audited worker registration and quota limits**\n\nChecked how workers register.',
      ),
      tool('read', { filePath: '/workspace/src/jobs-queue.ts' }),
      tool('read', { filePath: '/workspace/src/enrichment-worker.ts' }),
      tool('web_search', { query: 'postgres advisory lock leader election' }),
      tool('bash', { command: 'bun test enrichment' }, 3400),
      tool('memory', {}),
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
    label: 'plumbing only · reads "Housekeeping", never a work verb',
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

          <Section label="user message · full width, no reference chips">
            <UserMessage message={userMessage} />
          </Section>

          <Section label="plan card · 2 of 5, in-progress row visible">
            <PlanCard sessionId="ses_dbg" />
          </Section>

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
        </div>
      </div>
    </QueryClientProvider>
  );
}
