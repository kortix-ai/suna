import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
mock.module('@/lib/use-project-can', () => ({ useProjectCan: () => ({ allowed: true }) }));
// Render modal contents without a browser portal; keep the production form and SDK hook.
mock.module('@kortix/ui/modal', () => {
  const wrap = ({ children }: { children?: React.ReactNode }) => children;
  return Object.fromEntries(['Modal', 'ModalBody', 'ModalContent', 'ModalDescription', 'ModalFooter', 'ModalHeader', 'ModalTitle'].map((name) => [name, wrap]));
});
mock.module('@/components/site-link', () => ({ default: 'a' }));
const { AddExternalAppDialog } = await import('./app-add-external');

test('website URL form directs MCP servers to the governed connector surface', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      tree = create(createElement(QueryClientProvider, { client }, createElement(AddExternalAppDialog, {
        projectId: 'synthetic-project', open: true, onOpenChange: () => {}, onAdded: () => {},
      })));
    });
    const links = tree?.root.findAllByType('a') ?? [];
    expect(links.some((link) => link.props.href === '/projects/synthetic-project/customize/connectors')).toBe(true);
    expect(tree?.root.findByProps({ id: 'external-app-url' }).props.type).toBe('url');
  } finally {
    await act(async () => tree?.unmount());
    client.clear();
  }
});
