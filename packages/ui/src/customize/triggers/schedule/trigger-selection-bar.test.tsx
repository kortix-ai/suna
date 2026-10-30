import type { ProjectTrigger } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TriggerList } from './trigger-list';
import { TriggerSelectionBar } from './trigger-selection-bar';

const noop = () => {};
const bar = (props: Partial<Parameters<typeof TriggerSelectionBar>[0]> = {}) =>
  renderToStaticMarkup(
    <TriggerSelectionBar
      selectedCount={3}
      shownCount={5}
      allSelected={false}
      canPause
      canResume={false}
      canDelete
      progress={null}
      onSelectAll={noop}
      onClear={noop}
      onPause={noop}
      onResume={noop}
      onDelete={noop}
      onExit={noop}
      {...props}
    />,
  );

describe('TriggerSelectionBar', () => {
  test('the count is announced politely; Resume is disabled when it would change nothing', () => {
    const out = bar();
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain('3 selected');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*?Resume/);
    expect(out).toContain('data-slot="button-group"');
  });
  test('a running bulk action shows its progress and disables the actions', () => {
    const out = bar({ progress: { verb: 'pause', done: 3, total: 12 } });
    expect(out).toContain('Pausing 3 of 12…');
    expect(out).not.toContain('3 selected');
  });
});

describe('TriggerList in select mode', () => {
  const triggers = [
    { slug: 'a', name: 'Alpha', type: 'cron', enabled: true, event: null },
    { slug: 'b', name: 'Beta', type: 'cron', enabled: true, event: null },
  ] as unknown as ProjectTrigger[];
  test('a multiselectable listbox; rows expose aria-selected; checkboxes replace the clocks', () => {
    const out = renderToStaticMarkup(
      <TriggerList
        triggers={triggers}
        selectedSlug={null}
        onOpen={noop}
        selection={{ selected: new Set(['a']), onToggle: noop }}
      />,
    );
    expect(out).toContain('role="listbox"');
    expect(out).toContain('aria-multiselectable="true"');
    expect(out).toContain('aria-selected="true"');
    expect(out).toContain('aria-selected="false"');
    expect(out).not.toContain('role="img"');
  });
});
