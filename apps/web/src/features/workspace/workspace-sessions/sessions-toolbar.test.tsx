/**
 * Guards the one thing about this toolbar that fails silently: whether the
 * filter button is actually wired as a dropdown trigger.
 *
 * `Hint` spreads its extra props onto the Tooltip ROOT, not onto its child. So
 * `<DropdownMenuTrigger asChild><Hint><Button/></Hint></DropdownMenuTrigger>`
 * type-checks, lints, renders a perfectly normal-looking button — and drops the
 * trigger's onClick and ref on the floor. Clicking it does nothing at all.
 *
 * Radix stamps `aria-haspopup="menu"` onto whatever DOM node the trigger
 * resolves to. If that lands on the <button>, the composition is right; if the
 * order is inverted the attribute never reaches the button.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';

import type { WorkspaceSession } from '@kortix/sdk';

import { SessionsToolbar } from './sessions-toolbar';

const SESSIONS = [
  { session_id: 's1', workspace_id: 'p1', status: 'running', metadata: {}, opencode_sessions: [] },
  {
    session_id: 's2',
    workspace_id: 'p1',
    status: 'completed',
    metadata: {},
    opencode_sessions: [],
  },
] as unknown as WorkspaceSession[];

function render(overrides: Partial<Parameters<typeof SessionsToolbar>[0]> = {}) {
  return renderToStaticMarkup(
    // The app mounts one at the root; Hint needs it in scope to render at all.
    <TooltipProvider>
      <SessionsToolbar
        workspaceId="p1"
        sessions={SESSIONS}
        reviewCountBySession={{}}
        search=""
        onSearchChange={() => {}}
        searchOpen={false}
        onSearchOpenChange={() => {}}
        onEnterSelectMode={() => {}}
        onNewSession={() => {}}
        creatingSession={false}
        canSelect
        {...overrides}
      />
    </TooltipProvider>,
  );
}

/** The <button> element carrying the given aria-label, or null. */
function buttonWithLabel(markup: string, label: string): string | null {
  const match = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`));
  return match?.[0] ?? null;
}

describe('SessionsToolbar — filter trigger wiring', () => {
  test('the filter button is the dropdown trigger, not a plain button', () => {
    const filterButton = buttonWithLabel(render(), 'Session view options');

    expect(filterButton).not.toBeNull();
    // The assertion that catches the inverted Hint/Trigger nesting.
    expect(filterButton).toContain('aria-haspopup="menu"');
  });

  test('the trigger renders closed, and is a real button element', () => {
    const filterButton = buttonWithLabel(render(), 'Session view options');

    expect(filterButton).toContain('data-state="closed"');
    expect(filterButton).toContain('type="button"');
  });

  test('the search button is NOT a menu trigger — it toggles search directly', () => {
    // Proves the assertion above discriminates: this button is also wrapped in
    // a Hint, and must not pick up menu semantics.
    const searchButton = buttonWithLabel(render(), 'Search sessions');

    expect(searchButton).not.toBeNull();
    expect(searchButton).not.toContain('aria-haspopup');
  });

  test('no sessions means no view-options trigger at all', () => {
    expect(buttonWithLabel(render({ sessions: [] }), 'Session view options')).toBeNull();
  });
});
