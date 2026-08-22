import { KeyIcon, RobotIcon } from '@phosphor-icons/react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SessionOverridesControl,
  SessionOverridesControlContent,
  type SessionOverrideRow,
} from './session-overrides-control';

const rows = (overrides: Partial<SessionOverrideRow>[] = []): SessionOverrideRow[] => [
  {
    id: 'agent',
    name: 'Agent',
    icon: RobotIcon,
    hint: 'Who answers',
    summary: 'Project default',
    description: 'The agent that answers your next prompt.',
    editor: <div>agent editor</div>,
    ...overrides[0],
  },
  {
    id: 'secrets',
    name: 'Secrets',
    icon: KeyIcon,
    hint: 'Environment values',
    summary: 'Project default',
    description: 'Which project secrets reach this session.',
    editor: <div>secrets editor</div>,
    ...overrides[1],
  },
];

function render(props: Partial<React.ComponentProps<typeof SessionOverridesControlContent>> = {}) {
  return renderToStaticMarkup(
    <SessionOverridesControlContent rows={rows()} onSave={() => true} {...props} />,
  );
}

describe('SessionOverridesControlContent', () => {
  test('lists every axis and opens on the first one', () => {
    const html = render();

    expect(html).toContain('Agent');
    expect(html).toContain('Secrets');
    // Left pane lists all axes; the right pane shows only the focused one.
    expect(html).toContain('agent editor');
    expect(html).not.toContain('secrets editor');
    expect(html).toContain('The agent that answers your next prompt.');
    expect(html).toContain('Changes apply to the next prompt.');
  });

  test('every untouched axis reads as the project default, never "none"', () => {
    const html = render();

    expect(html.match(/Project default/g)).toHaveLength(2);
    expect(html).not.toContain('None selected');
    expect(html).not.toContain('>Override<');
  });

  test('badges only the axes that actually hold an override', () => {
    const html = render({
      rows: rows([{}, { summary: '2 selected', overridden: true }]),
    });

    expect(html.match(/>Override</g)).toHaveLength(1);
    expect(html).toContain('2 selected');
  });

  test('offers the way out of an override, and only when one exists', () => {
    // The reset lives in the PANEL, beside the editor — an axis whose catalog
    // came back empty must not be able to hide the only way back to the
    // default.
    const overridden = render({
      rows: rows([{ overridden: true, onReset: () => {}, resetLabel: 'Reset to agent default' }, {}]),
    });
    const inherited = render({
      rows: rows([{ onReset: () => {}, resetLabel: 'Reset to agent default' }, {}]),
    });

    // The label names where the default actually comes from, per axis.
    expect(overridden).toContain('Reset to agent default');
    expect(inherited).not.toContain('Reset to agent default');
  });

  test('disables only the save action while a save is impossible', () => {
    const html = render({ saveDisabled: true });

    expect(html).toContain('disabled=""');
    expect(html).toContain('Save');
  });

  test('uses a non-submit toolbar trigger inside the composer', () => {
    const html = renderToStaticMarkup(
      <SessionOverridesControl rows={rows()} onSave={() => true} />,
    );

    expect(html).toContain('aria-label="Session overrides"');
    expect(html).toContain('type="button"');
  });

  test('the trigger is an icon and nothing else, overrides or not', () => {
    // The composer bar says nothing about the axes — muted icon only, even
    // while overrides are in force. The panel is where overrides live.
    const quiet = renderToStaticMarkup(
      <SessionOverridesControl rows={rows()} onSave={() => true} />,
    );
    expect(quiet).toContain('text-muted-foreground');
    expect(quiet).not.toContain('Session<');

    const withOverrides = renderToStaticMarkup(
      <SessionOverridesControl
        rows={rows([{ overridden: true }, { overridden: true }])}
        onSave={() => true}
      />,
    );
    // Row names/counts never leak onto the closed trigger.
    expect(withOverrides).not.toContain('2 overrides');
    expect(withOverrides).not.toContain('>Agent<');
  });
});
