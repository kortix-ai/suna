import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentAdvanced } from './agent-advanced';

function render(extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <AgentAdvanced {...extra}>
      <p>the-advanced-content</p>
    </AgentAdvanced>,
  );
}

describe('the one Advanced disclosure', () => {
  test('renders a trigger labelled Advanced', () => {
    const html = render();
    expect(html).toContain('Advanced');
    expect(html).toContain('aria-label="Advanced"');
  });

  test('starts collapsed', () => {
    const html = render();
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('the-advanced-content');
  });

  test('says what is inside so nothing hides without a trace', () => {
    expect(render()).toContain('Assignments, governance &amp; access scope');
  });

  test('the summary line is overridable', () => {
    expect(render({ summary: 'Scope only' })).toContain('Scope only');
  });

  test('the trigger is a real keyboard-reachable button', () => {
    const html = render();
    expect(html).toContain('type="button"');
    expect(html).toContain('role="button"');
  });
});
