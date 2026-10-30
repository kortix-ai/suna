/**
 * MarkdownImage's compact mode (a small genui thumbnail) and its failure hand-off to the caller. React Native and
 * the design-system primitives are host stubs; the sandbox loader is a stub whose phase each test sets.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

const sandbox = {
  phase: 'load' as 'probe' | 'load' | 'tap-to-load' | 'error',
  loadAnyway: mock(() => {}),
  handleError: mock(() => {}),
};

mock.module('react-native', () => ({
  View: host('view'),
  Pressable: host('pressable'),
  ScrollView: host('scroll'),
  Image: host('image'),
}));
mock.module('@/components/kortix/confirm-dialog', () => ({ useConfirmDialog: () => ({ confirm: () => {}, dialog: null }) }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/markdown/markdown-theme', () => ({ markdownPalette: () => ({ imageOutline: 'outline' }) }));
mock.module('@/components/session/turn/use-sandbox-image', () => ({
  useSandboxImage: () => ({
    phase: sandbox.phase,
    attempt: 0,
    source: sandbox.phase === 'load' ? { uri: 'https://sandbox.test/file.png', headers: {} } : null,
    loadAnyway: sandbox.loadAnyway,
    handleError: sandbox.handleError,
  }),
}));
mock.module('@/stores/tool-file-preview-store', () => ({ useToolFilePreviewStore: { getState: () => ({ openPreview: () => {} }) } }));
mock.module('@/lib/icons', () => ({ ImageIcon: 'image-icon' }));
mock.module('@/lib/utils/open-link', () => ({ openExternalLink: () => {}, openLink: async () => {} }));

let MarkdownImage: typeof import('./markdown-image').MarkdownImage;
let MarkdownImagesContext: typeof import('./markdown-image').MarkdownImagesContext;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ MarkdownImage, MarkdownImagesContext } = await import('./markdown-image'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  sandbox.phase = 'load';
  sandbox.loadAnyway.mockClear();
  sandbox.handleError.mockClear();
});

function render(element: React.ReactElement, remote: 'load' | 'placeholder' = 'placeholder') {
  act(() => {
    tree = create(<MarkdownImagesContext.Provider value={remote}>{element}</MarkdownImagesContext.Provider>);
  });
  return tree!.root;
}
const all = (root: ReactTestInstance, type: string) => root.findAll((n) => n.type === (type as never));
const texts = (root: ReactTestInstance) => all(root, 'text').flatMap((n) => n.children);
const className = (n: ReactTestInstance) => String(n.props.className ?? '');

/** The compact button: icon only, filling the thumbnail's box, named for a screen reader. */
function expectCompactButton(root: ReactTestInstance, label: string) {
  expect(all(root, 'button')).toHaveLength(0);
  expect(texts(root)).toEqual([]);
  const button = all(root, 'pressable').find((n) => n.props.accessibilityLabel === label)!;
  expect(button).toBeDefined();
  expect(className(button)).toContain('size-full');
  expect(all(button, 'icon').map((n) => n.props.as)).toEqual(['image-icon']);
  return button;
}

describe('MarkdownImage compact mode', () => {
  test('a remote image that may not load is the labelled placeholder button by default', () => {
    const root = render(<MarkdownImage src="https://example.com/a.png" alt="" isDark={false} />);
    expect(all(root, 'button')).toHaveLength(1);
    expect(texts(root)).toEqual(['example.com']);
  });

  test('compact, a remote image that may not load is an icon-only button that fills its box', () => {
    const root = render(<MarkdownImage src="https://example.com/a.png" alt="" isDark={false} look={{ compact: true }} />);
    expectCompactButton(root, 'Image: example.com');
  });

  test('compact, a remote image that fails is the icon-only button', () => {
    const root = render(<MarkdownImage src="https://example.com/a.png" alt="" isDark={false} look={{ compact: true }} />, 'load');
    act(() => (all(root, 'image')[0]!.props.onError as () => void)());
    expectCompactButton(root, 'Image: example.com');
  });

  test('a large sandbox image waits for a tap: the labelled button by default, an icon-only button compact', () => {
    sandbox.phase = 'tap-to-load';
    const full = render(<MarkdownImage src="/workspace/big.png" alt="" isDark={false} />);
    expect(all(full, 'button')).toHaveLength(1);
    expect(texts(full)).toEqual(['Load image']);
    act(() => tree?.unmount());

    const compact = render(<MarkdownImage src="/workspace/big.png" alt="" isDark={false} look={{ compact: true }} />);
    const button = expectCompactButton(compact, 'Load image');
    act(() => (button.props.onPress as () => void)());
    expect(sandbox.loadAnyway).toHaveBeenCalledTimes(1);
  });

  test('a failed sandbox image hands its failure to the caller, once, as a remote image does', () => {
    sandbox.phase = 'error';
    const onError = mock(() => {});
    const root = render(<MarkdownImage src="/workspace/gone.png" alt="" isDark={false} look={{ compact: true, onError }} />);
    expect(onError).toHaveBeenCalledTimes(1);
    // The caller drops its box; nothing else draws in it meanwhile.
    expect(all(root, 'button')).toHaveLength(0);
    expect(all(root, 'pressable')).toHaveLength(0);
    act(() => tree!.update(
      <MarkdownImagesContext.Provider value="placeholder">
        <MarkdownImage src="/workspace/gone.png" alt="" isDark={false} look={{ compact: true, onError }} />
      </MarkdownImagesContext.Provider>,
    ));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('a failed sandbox image with no caller fallback is the placeholder: labelled by default, icon-only compact', () => {
    sandbox.phase = 'error';
    const full = render(<MarkdownImage src="/workspace/gone.png" alt="" isDark={false} />);
    expect(texts(full)).toEqual(['Image']);
    act(() => tree?.unmount());
    const compact = render(<MarkdownImage src="/workspace/gone.png" alt="" isDark={false} look={{ compact: true }} />);
    expect(all(compact, 'pressable')).toHaveLength(1);
    expect(texts(compact)).toEqual([]);
  });
});
