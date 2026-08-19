import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AccessList, AccessRow, ACCESS_ROW_CLASS } from './access-row';

/** Static markup assertions only — the idiom used by
 *  `settings-nav-context.test.tsx` and `components/ui/*.test.tsx`. */
function render(node: React.ReactElement) {
  return renderToStaticMarkup(node);
}

describe('AccessRow anatomy', () => {
  test('renders the canonical MembersCard row classes', () => {
    const html = render(<AccessRow title="alice@corp.com" />);
    expect(html).toContain(ACCESS_ROW_CLASS.split(' ')[0]);
    expect(html).toContain('alice@corp.com');
    expect(ACCESS_ROW_CLASS).toBe('bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5');
  });

  test('metaParts render through InlineMeta', () => {
    const html = render(
      <AccessRow title="alice@corp.com" metaParts={['Joined Aug 18, 2026', '3 projects']} />,
    );
    expect(html).toContain('Joined Aug 18, 2026');
    expect(html).toContain('3 projects');
  });

  test('badges and trailing role sit on the row', () => {
    const html = render(
      <AccessRow title="Engineering" badges={<span>Group</span>} trailing="Manager" />,
    );
    expect(html).toContain('Group');
    expect(html).toContain('Manager');
  });

  test('dashed marks a pending invite', () => {
    expect(render(<AccessRow title="new@corp.com" dashed />)).toContain('border-dashed');
    expect(render(<AccessRow title="new@corp.com" />)).not.toContain('border-dashed');
  });

  test('pending swaps the kebab for a spinner', () => {
    const html = render(
      <AccessRow title="a" pending kebab={[{ label: 'Edit access', onSelect: () => {} }]} />,
    );
    expect(html).not.toContain('aria-label="Actions"');
  });

  test('a kebab renders one trigger, never a submenu', () => {
    const html = render(
      <AccessRow
        title="a"
        kebabLabel="Actions for a"
        kebab={[
          { label: 'Edit access', onSelect: () => {} },
          { label: 'Remove access', onSelect: () => {}, variant: 'destructive' },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Actions for a"');
  });

  test('notEditable renders the Shield affordance instead of a kebab', () => {
    const html = render(
      <AccessRow
        title="a"
        notEditable={{ hint: 'Owners and admins always have Manager on every project.' }}
        kebab={[{ label: 'Edit access', onSelect: () => {} }]}
      />,
    );
    expect(html).not.toContain('aria-label="Actions"');
    expect(html).toContain('svg');
  });

  test('onClick makes the row keyboard-activatable', () => {
    const html = render(<AccessRow title="Engineering" onClick={() => {}} />);
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(render(<AccessRow title="Engineering" />)).not.toContain('role="button"');
  });

  test('selectable renders a checkbox with an accessible name', () => {
    const html = render(
      <AccessRow
        title="a"
        selectable={{ checked: true, onCheckedChange: () => {}, label: 'Select a' }}
      />,
    );
    expect(html).toContain('aria-label="Select a"');
    expect(html).toContain('type="checkbox"');
  });

  test('reserveSpace keeps the avatar column aligned without a checkbox', () => {
    const html = render(
      <AccessRow
        title="a"
        selectable={{ checked: false, onCheckedChange: () => {}, label: 'Select a', reserveSpace: true }}
      />,
    );
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('aria-hidden');
  });
});

describe('AccessList', () => {
  test('header renders "{title} · {count}"', () => {
    const html = render(
      <AccessList header={{ title: 'Members', count: 4 }}>
        <AccessRow title="a" />
      </AccessList>,
    );
    expect(html).toContain('Members · 4');
  });

  test('a header without a count omits the separator', () => {
    const html = render(
      <AccessList header={{ title: 'Access' }}>
        <AccessRow title="a" />
      </AccessList>,
    );
    expect(html).toContain('Access');
    expect(html).not.toContain('Access ·');
  });

  test('selectable adds "Select all visible" only when something is eligible', () => {
    const withEligible = render(
      <AccessList
        header={{ title: 'Members', count: 2 }}
        selectable={{ selectedIds: [], eligibleIds: ['u_1'], onToggleAll: () => {} }}
      >
        <AccessRow title="a" />
      </AccessList>,
    );
    expect(withEligible).toContain('Select all visible');

    const withoutEligible = render(
      <AccessList
        header={{ title: 'Members', count: 2 }}
        selectable={{ selectedIds: [], eligibleIds: [], onToggleAll: () => {} }}
      >
        <AccessRow title="a" />
      </AccessList>,
    );
    expect(withoutEligible).not.toContain('Select all visible');
  });

  test('every eligible row selected flips the control to "Deselect all"', () => {
    const html = render(
      <AccessList
        header={{ title: 'Members', count: 2 }}
        selectable={{
          selectedIds: new Set(['u_1', 'u_2']),
          eligibleIds: ['u_1', 'u_2'],
          onToggleAll: () => {},
        }}
      >
        <AccessRow title="a" />
      </AccessList>,
    );
    expect(html).toContain('Deselect all');
  });

  test('rows are a <ul> of <li>, matching the customize-view list dialect', () => {
    const html = render(
      <AccessList>
        <AccessRow title="a" />
        <AccessRow title="b" />
      </AccessList>,
    );
    expect(html).toContain('<ul');
    expect((html.match(/<li/g) ?? []).length).toBe(2);
  });
});
