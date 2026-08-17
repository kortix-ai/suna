import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { GetMemTool } from './get-mem-tool';

// Task 5: get-mem rebuilt on the grammar (BasicTool + ToolSection/ToolField).
// This is a content-preservation check — every field the old bespoke
// gradient card rendered (title, narrative, facts, concepts, tool/session,
// files read) must still render after the rebuild.

// GetMemTool calls `useTranslations('hardcodedUi')` unconditionally (for its
// Observation#/LTM#/Prompt#/Files-read labels) — see show-tool.test.tsx for
// the same requirement.
const HARDCODED_UI_MESSAGES = {
  hardcodedUi: {
    componentsSessionToolRenderers: {
      line1730JsxTextObservation: 'Observation #',
      line1811JsxTextPrompt: 'Prompt #',
      line1823JsxTextFilesRead: 'Files read',
      line1847JsxTextLTM: 'LTM #',
    },
  },
};

function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={HARDCODED_UI_MESSAGES} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

function makePart(input: Record<string, unknown>, output: string): ToolPart {
  return {
    type: 'tool',
    tool: 'get_mem',
    callID: 'call-1',
    state: {
      status: 'completed',
      input,
      output,
      metadata: {},
    },
  } as unknown as ToolPart;
}

const OBSERVATION_OUTPUT = `=== Observation #42 [insight] ===
Title: Refactored auth flow
Narrative:
Simplified the login flow by removing redundant redirects.
Tool: edit_file | Prompt #7
Session: sess-99
Created: 2026-07-01
Facts:
- Removed duplicate middleware
Concepts: auth, refactor
Files read: src/auth.ts, src/login.tsx`;

const LTM_OUTPUT = `=== LTM #9 [fact] ===
Caption: User prefers dark mode
Content: The user explicitly asked for dark mode as default across all surfaces.
Session: sess-1
Created: 2026-06-01 | Updated: 2026-06-15
Tags: preference, ui`;

describe('GetMemTool joins the shared BasicTool shell', () => {
  test('inline surface: no bespoke gradient/shadow chrome, observation content preserved', () => {
    const html = renderToStaticMarkup(
      withProviders(<GetMemTool part={makePart({ id: 42 }, OBSERVATION_OUTPUT)} defaultOpen />),
    );

    expect(html).not.toContain('rounded-2xl');
    expect(html).not.toContain('shadow-sm');
    expect(html).not.toContain('bg-gradient');
    expect(html).not.toContain('sky-');

    // Grammar: the report renders in a flat muted card, and the freeform
    // prose flows through OutputBlock (capped + scrollable), not a bare <p>.
    expect(html).toContain('bg-muted/20');
    expect(html).toContain('max-h-96');

    // The ANSWER stays visible: what the memory says, and which call made it.
    expect(html).toContain('Refactored auth flow');
    expect(html).toContain('Simplified the login flow');
    expect(html).toContain('edit_file');
    expect(html).toContain('sess-99');
  });

  // Task 20: the provenance sections that used to stack open under the answer
  // — request, facts, concepts, files read — are CLOSED disclosures. The
  // reader gets the memory; the extraction record is one click away.
  test('inline surface: provenance folds closed, its labels are the triggers', () => {
    const html = renderToStaticMarkup(
      withProviders(<GetMemTool part={makePart({ id: 42 }, OBSERVATION_OUTPUT)} defaultOpen />),
    );

    // Every fold is closed, and each one still announces what it holds.
    expect(html).toContain('Facts (1)');
    expect(html).toContain('Concepts');
    expect(html).toContain('Files read (2)');
    expect(html).toContain('Request');
    expect(html).toContain('aria-expanded="false"');

    // …and holds it: the bodies are not in the markup at all.
    expect(html).not.toContain('Removed duplicate middleware');
    expect(html).not.toContain('src/auth.ts');
    expect(html).not.toContain('src/login.tsx');
    // 'refactor' is a concept; 'Refactored auth flow' is the visible title, so
    // this asserts on the lowercase concept exactly.
    expect(html).not.toContain('>refactor<');
  });

  // Task 16 REWRITE: the panel surface is a closed-by-default disclosure row,
  // not a sticky page header over an open body. The content assertions stay —
  // they are the point of this test — so the row is opened with `defaultOpen`,
  // which is exactly what the panel passes when a detail holds one call.
  test('panel surface: disclosure row, LTM content preserved once opened', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <GetMemTool part={makePart({ id: 9 }, LTM_OUTPUT)} defaultOpen />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).not.toContain('sticky');
    expect(html).toContain('bg-popover border-border overflow-hidden rounded-md border');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('text-sm font-medium');
    expect(html).toContain('Recalled');

    // Caption and content are the entry — they stay open on the panel too.
    expect(html).toContain('User prefers dark mode');
    expect(html).toContain('The user explicitly asked for dark mode');
    expect(html).toContain('sess-1');

    // Tags are metadata about the entry, not the entry: folded, labelled,
    // counted.
    expect(html).toContain('Tags (2)');
    expect(html).not.toContain('>preference<');

    expect(html).not.toContain('rounded-2xl');
    expect(html).not.toContain('shadow-sm');
    expect(html).not.toContain('bg-gradient');
  });
});

// ─── Phase 6 gate, finding 4 (MEDIUM) — a shut row must say WHAT was recalled ─
//
// A group of these rows read `Recalled · #482` and `Recalled · #1180`: two
// identical titles and two opaque ids. The payload already carries the words —
// an observation has a `Title:`, an LTM entry a `Caption:` — so the subtitle
// carries those and the record id moves to the badge at the row's right edge.
describe('the closed get_mem row names the memory (gate finding 4)', () => {
  const closedTrigger = (part: ToolPart) =>
    renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <GetMemTool part={part} />
        </ToolSurfaceContext.Provider>,
      ),
    );

  test("an observation's title is the subtitle, its id is the badge", () => {
    const html = closedTrigger(makePart({ id: 42 }, OBSERVATION_OUTPUT));

    // Closed: everything asserted below is trigger content, not body content.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Simplified the login flow');

    // The subtitle span carries the memory's own words…
    expect(html).toContain('title="Refactored auth flow"');
    // …and the id rides the badge, which is the row's `shrink-0` trailing slot.
    expect(html).toContain('text-muted-foreground/60 shrink-0 font-mono text-xs');
    expect(html).toContain('>#42</span>');
  });

  test('an LTM entry falls back to its caption', () => {
    const html = closedTrigger(makePart({ id: 9 }, LTM_OUTPUT));

    expect(html).toContain('title="User prefers dark mode"');
    expect(html).toContain('>#9</span>');
  });

  test('with nothing parsed, the id is still the subtitle — never an empty row', () => {
    // Streaming, or an output shape this parser does not recognize. The id is
    // all there is, so it stays where the reader can see it.
    const html = closedTrigger(makePart({ id: 77 }, 'still thinking…'));

    expect(html).toContain('title="#77"');
    expect(html).toContain('Recalled');
  });
});

// ─── Phase 6 gate, finding 3 (HIGH) — the meta line is ONE line ──────────────
//
// The `<span>` holding the fingerprint icon plus `Observation #482` had no
// `inline-flex items-center`, so the icon claimed its own line box: it sat
// ABOVE the text, and the uppercase type label beside it rode on a different
// baseline. The created date's `ml-auto` then pushed it to the far right of a
// `flex-wrap` row, wrapping it onto a second line with a wide dead gap under
// the id. And `Prompt #` reached `ToolField`, whose `gap-2` rendered the
// number as `Prompt # 14`.
describe('the get_mem meta line (gate finding 3)', () => {
  const opened = renderToStaticMarkup(
    withProviders(<GetMemTool part={makePart({ id: 42 }, OBSERVATION_OUTPUT)} defaultOpen />),
  );

  test('the id span lays its icon out inline, so text and icon share a baseline', () => {
    const idx = opened.indexOf('Observation #');
    expect(idx).toBeGreaterThan(-1);
    const openTag = opened.slice(
      opened.lastIndexOf('<span', opened.lastIndexOf('<span', idx) - 1),
      idx,
    );
    expect(openTag).toContain('inline-flex items-center');
  });

  test('the created date is in flow, not flung right by ml-auto', () => {
    expect(opened).toContain('2026-07-01');
    // `ml-auto` in a `flex-wrap` row is what put the date on its own line with
    // a dead gap beside the id it belongs to.
    expect(opened).not.toContain('ml-auto');
  });

  test('the prompt number is not separated from its own # by a field gap', () => {
    // `Prompt #` + `ToolField`'s `gap-2` + `7` rendered as `Prompt # 7`. The
    // marker belongs to the number, so they are set adjacent — and the token
    // stays whole, which is what keeps `Prompt n°` / `Prompt nº` correct.
    expect(opened).toContain('Prompt #<span class="text-foreground/80">7</span>');
    expect(opened).not.toContain('shrink-0">Prompt #</span>');
  });
});
