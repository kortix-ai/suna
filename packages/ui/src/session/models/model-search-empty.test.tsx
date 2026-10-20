import { expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { IntlTestProvider } from '../../test-utils/intl';
import { ModelSearchEmpty } from './model-search-empty';

test('single-model search explains the available scope and opens the upgrade path', () => {
  let upgrades = 0;
  let clears = 0;
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <IntlTestProvider>
        <ModelSearchEmpty
          search="claude"
          modelCount={1}
          onClear={() => clears++}
          onUpgrade={() => upgrades++}
        />
      </IntlTestProvider>,
    );
  });
  if (!renderer) throw new Error('Renderer not mounted');
  const mounted = renderer;
  expect(JSON.stringify(mounted.toJSON())).toContain(
    'Only 1 model is available in this project.',
  );
  const buttons = mounted.root.findAllByType('button');
  const upgrade = buttons.find((button) => button.props.children === 'Upgrade');
  expect(upgrade).toBeDefined();
  act(() => upgrade?.props.onClick());
  act(() => buttons[0]?.props.onClick());
  expect(upgrades).toBe(1);
  expect(clears).toBe(1);
  act(() => mounted.unmount());
});

test('ordinary misses keep search guidance without an upgrade when billing is off', () => {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <IntlTestProvider>
        <ModelSearchEmpty search="missing" modelCount={12} onClear={() => {}} />
      </IntlTestProvider>,
    );
  });
  if (!renderer) throw new Error('Renderer not mounted');
  const mounted = renderer;
  expect(JSON.stringify(mounted.toJSON())).toContain('Try a different search.');
  expect(JSON.stringify(mounted.toJSON())).not.toContain('Only 1 model');
  expect(mounted.root.findAllByType('button')).toHaveLength(1);
  act(() => mounted.unmount());
});

test('a single BYOK model still explains scope without a dead upgrade action', () => {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <IntlTestProvider>
        <ModelSearchEmpty search="gpt" modelCount={1} onClear={() => {}} />
      </IntlTestProvider>,
    );
  });
  if (!renderer) throw new Error('Renderer not mounted');
  const mounted = renderer;
  expect(JSON.stringify(mounted.toJSON())).toContain(
    'Only 1 model is available',
  );
  expect(mounted.root.findAllByType('button')).toHaveLength(1);
  act(() => mounted.unmount());
});
