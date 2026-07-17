import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '@/ui';

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

    // Content preserved: title, narrative, facts, concepts, tool/session, files.
    expect(html).toContain('Refactored auth flow');
    expect(html).toContain('Simplified the login flow');
    expect(html).toContain('Removed duplicate middleware');
    expect(html).toContain('auth');
    expect(html).toContain('refactor');
    expect(html).toContain('edit_file');
    expect(html).toContain('sess-99');
    expect(html).toContain('src/auth.ts');
    expect(html).toContain('src/login.tsx');
  });

  test('panel surface: standard sticky header, LTM content preserved', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <GetMemTool part={makePart({ id: 9 }, LTM_OUTPUT)} />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).toContain('sticky');
    expect(html).toContain('text-sm font-medium');
    expect(html).toContain('Get Mem');

    expect(html).toContain('User prefers dark mode');
    expect(html).toContain('The user explicitly asked for dark mode');
    expect(html).toContain('preference');
    expect(html).toContain('ui');
    expect(html).toContain('sess-1');

    expect(html).not.toContain('rounded-2xl');
    expect(html).not.toContain('shadow-sm');
    expect(html).not.toContain('bg-gradient');
  });
});
