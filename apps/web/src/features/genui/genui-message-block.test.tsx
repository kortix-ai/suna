import { afterEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { PANEL_EVENTS } from '@/lib/track';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';

import GenuiMessageBlock from './genui-message-block';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const CODE = 'root = Stack([a, b])\na = Stat("Revenue", "12k")\nb = Callout("info", "Book by Friday")';

// A client render: zustand serves its initial state as the server snapshot, so a
// static (SSR) render never sees a preference changed after the store was created.
let mounted: ReactTestRenderer | null = null;
async function render(): Promise<ReactTestRenderer> {
  await act(async () => {
    mounted = create(<GenuiMessageBlock code={CODE} version={1} streaming={false} cutOff={false} trust="agent" variant="message" />);
  });
  return mounted!;
}

const textOf = (renderer: ReactTestRenderer): string => {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(renderer.toJSON());
  return parts.join(' ');
};

afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = null;
  useUserPreferencesStore.getState().setGenuiEnabled(true);
});

describe('GenuiMessageBlock', () => {
  test('renders the block as UI by default, including legacy preferences without the key', async () => {
    useUserPreferencesStore.setState((s) => ({ preferences: { ...s.preferences, genuiEnabled: undefined } }));
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('Revenue');
    expect(text).toContain('Book by Friday');
    expect(text).not.toContain('root = Stack');
    expect(renderer.root.findAllByType('strong')).toHaveLength(0);
  });

  test('the personal off switch renders the markdown fallback', async () => {
    useUserPreferencesStore.getState().setGenuiEnabled(false);
    const renderer = await render();
    const strong = renderer.root.findAllByType('strong');
    expect(strong.map((node) => node.children.join(''))).toContain('Revenue:');
    expect(textOf(renderer)).toContain('12k');
    expect(textOf(renderer)).not.toContain('root = Stack');
  });

  test('genui_block is a closed telemetry event', () => {
    expect(PANEL_EVENTS).toContain('genui_block');
  });
});
