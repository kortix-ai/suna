import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { InstructionsTabView } from './instructions-tab';

/**
 * `InstructionsTabView` is the pure, props-only half — no hooks, no data
 * fetching (see this tab's header comment). `commandsSlot` stands in for
 * `CommandsView`, which cannot render under `renderToStaticMarkup` with no
 * `QueryClientProvider` — same reasoning as `sandbox-tab.test.tsx`'s
 * `templatesSlot` marker tests. `settings-panel.test.tsx`'s `REAL_VIEW_TABS`
 * loop separately proves the real `CommandsView` still mounts (and throws
 * with no provider, i.e. actually runs) when `instructions` is active.
 */
describe('InstructionsTabView', () => {
  test('renders the pane heading and the commands slot it is given', () => {
    const out = renderToStaticMarkup(
      <InstructionsTabView commandsSlot={<div>commands-list-marker</div>} />,
    );
    expect(out).toContain('Instructions');
    expect(out).toContain('commands-list-marker');
  });

  test('renders the pane heading with no slot — the bare view needs no providers', () => {
    const out = renderToStaticMarkup(<InstructionsTabView />);
    expect(out).toContain('Instructions');
  });
});
