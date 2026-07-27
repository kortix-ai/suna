/**
 * A realistic transcript for the chat-variant demo.
 *
 * Modelled part-for-part on a real session (build a spreadsheet, then a
 * ten-slide deck) — including the `step-start` / `step-finish` bookkeeping the
 * runtime actually emits, because those parts are exactly what broke grouping.
 * A fixture without them would make every variant look better than it is.
 *
 * Demo-only. Nothing here ships in a session route.
 */

import type { MessageWithParts, Part } from '@/ui';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

/** Wall-clock cursor, so durations in the demo look like real ones. */
let clock = 0;
function span(ms: number) {
  const start = clock;
  clock += ms;
  return { start, end: clock };
}

function step(phase: 'start' | 'finish'): Part {
  return { id: nextId('step'), type: `step-${phase}` } as unknown as Part;
}

function text(value: string): Part {
  return { id: nextId('text'), type: 'text', text: value } as unknown as Part;
}

function reasoning(value: string): Part {
  return { id: nextId('reasoning'), type: 'reasoning', text: value } as unknown as Part;
}

function bash(command: string, description: string, output = '', ms = 900): Part[] {
  return [
    step('start'),
    {
      id: nextId('part'),
      type: 'tool',
      tool: 'bash',
      callID: nextId('call'),
      state: {
        status: 'completed',
        input: { command, description },
        output,
        time: span(ms),
      },
    } as unknown as Part,
    step('finish'),
  ];
}

function write(path: string, ms = 400): Part[] {
  return [
    step('start'),
    {
      id: nextId('part'),
      type: 'tool',
      tool: 'write',
      callID: nextId('call'),
      state: {
        status: 'completed',
        input: { filePath: path, content: '…' },
        output: `Wrote ${path}`,
        time: span(ms),
      },
    } as unknown as Part,
    step('finish'),
  ];
}

function read(path: string, ms = 250): Part[] {
  return [
    step('start'),
    {
      id: nextId('part'),
      type: 'tool',
      tool: 'read',
      callID: nextId('call'),
      state: {
        status: 'completed',
        input: { filePath: path },
        output: '…',
        time: span(ms),
      },
    } as unknown as Part,
    step('finish'),
  ];
}

function show(title: string, url: string, ms = 300): Part[] {
  return [
    step('start'),
    {
      id: nextId('part'),
      type: 'tool',
      tool: 'show',
      callID: nextId('call'),
      state: {
        status: 'completed',
        input: { title, url, kind: 'preview' },
        output: url,
        time: span(ms),
      },
    } as unknown as Part,
    step('finish'),
  ];
}

function todo(items: Array<{ content: string; status: 'completed' | 'in_progress' | 'pending' }>): Part[] {
  return [
    {
      id: nextId('part'),
      type: 'tool',
      tool: 'todowrite',
      callID: nextId('call'),
      state: {
        status: 'completed',
        input: { todos: items.map((t, i) => ({ id: String(i), ...t, priority: 'medium' })) },
        time: span(50),
      },
    } as unknown as Part,
  ];
}

function userMessage(id: string, body: string): MessageWithParts {
  return {
    info: { id, role: 'user', sessionID: 'demo', time: { created: 0 } },
    parts: [text(body)],
  } as unknown as MessageWithParts;
}

function assistantMessage(id: string, parts: Part[]): MessageWithParts {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 'demo',
      time: { created: 0, completed: 1 },
      tokens: { input: 48_200, output: 6_100, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.42,
      modelID: 'glm-5.2',
      providerID: 'kortix',
    },
    parts,
  } as unknown as MessageWithParts;
}

/**
 * Turn 1 — the shape from the screenshot: a long run of near-identical shell
 * commands between short bursts of narration.
 */
export function buildDemoMessages(): MessageWithParts[] {
  seq = 0;
  clock = Date.parse('2026-07-25T10:00:00Z');

  const SCRIPT = '/workspace/.kortix/opencode/skills/presentations/presentation.py';

  return [
    userMessage(
      'user-1',
      'Build me a spreadsheet of Jason Calacanis’s portfolio and then a deck covering his career and investing thesis.',
    ),

    assistantMessage('asst-1', [
      ...todo([
        { content: 'Research Calacanis portfolio', status: 'completed' },
        { content: 'Build the spreadsheet', status: 'completed' },
        { content: 'Build the deck', status: 'in_progress' },
        { content: 'Validate every slide', status: 'pending' },
        { content: 'Export to PDF', status: 'pending' },
        { content: 'Start the viewer', status: 'pending' },
      ]),

      reasoning(
        'The spreadsheet is done and rendering cleanly. Next is the deck — I want a premium dark look with a single teal accent, and I should confirm the presentation skill is available before I start building slides.',
      ),

      text(
        'Spreadsheet is rendering well — clean teal-accented design, unicorns highlighted gold, exits green, sector pivot works. Now let me build the presentation.',
      ),

      // The "checking the toolchain" burst — three shells, invisible to a user.
      ...bash('ls ~/.opencode/skills/presentations/ 2>/dev/null', 'Check the skill is installed', 'presentation.py', 300),
      ...bash(`ls /workspace/.kortix/opencode/skills/presentations/ && which bun`, 'Locate the presentation script', '/usr/bin/bun', 260),
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT --help`, 'Check the script runs', 'usage: presentation.py …', 1_100),

      text(
        'Good, the presentation tool works. Now let me plan the deck. I’ll build a ~9-slide deck covering Jason Calacanis’s life, career, investing thesis, key wins, portfolio breakdown, and influence. I’ll commit to a premium dark + single teal accent motif throughout.',
      ),

      // The wall of ten near-identical builds — the exact failure in the screenshot.
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT build --slide 1`, 'Build slide 1 — title', '', 1_400),
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT build --slide 2`, 'Build slide 2 — early life', '', 1_200),
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT build --slide 3`, 'Build slide 3 — Weblogs', '', 1_150),
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT build --slide 4`, 'Build slide 4 — Mahalo', '', 1_050),
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT build --slide 5`, 'Build slide 5 — This Week in Startups', '', 1_300),
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT build --slide 6`, 'Build slide 6 — investing thesis', '', 1_250),
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT build --slide 7`, 'Build slide 7 — Uber and Robinhood', '', 1_180),
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT build --slide 8`, 'Build slide 8 — portfolio breakdown', '', 1_220),
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT build --slide 9`, 'Build slide 9 — LAUNCH and the syndicate', '', 1_090),
      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT build --slide 10`, 'Build slide 10 — influence and legacy', '', 1_010),

      text('10-slide deck built. Let me validate all slides and start the viewer to preview them.'),

      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT validate --slide 1`, 'Validate slide 1', 'OK 1920x1080', 4_000),

      text('Slide 1 validates perfectly at 1920×1080. Let me validate all slides and check the rest at the same time.'),

      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT validate --all`, 'Validate every slide', 'All 10 slides OK — 1920x1080, no overflow', 3_200),

      text('All 10 slides validate perfectly — exact 1920×1080, no overflow. Let me export to PDF and start the viewer for live preview.'),

      ...bash(`cd /workspace && SCRIPT=${SCRIPT} && python3 $SCRIPT export --pdf`, 'Export the deck to PDF', 'Wrote calacanis.pdf', 5_400),
      ...bash('cd /workspace && ls -la presentations/calacanis/ && pdftoppm -jpeg -r 96 calacanis.pdf thumb', 'Render preview thumbnails', 'thumb-01.jpg … thumb-10.jpg', 2_600),
      ...write('/workspace/presentations/calacanis/index.html'),
      ...write('/workspace/presentations/calacanis/manifest.json'),
      ...read('/workspace/presentations/calacanis/manifest.json'),
      ...bash('cd /workspace/presentations/calacanis && python3 -m http.server 3000 &', 'Start the preview server', 'Serving on :3000', 700),

      ...show('Calacanis — 10 slides', 'https://preview.kortix.dev/calacanis'),

      text(
        'Done. The deck is live at the preview link above — 10 slides, premium dark with a teal accent, exported to PDF alongside the spreadsheet.\n\nWant me to adjust the tone, add a slide on his media strategy, or export it to PowerPoint?',
      ),
    ]),
  ];
}
