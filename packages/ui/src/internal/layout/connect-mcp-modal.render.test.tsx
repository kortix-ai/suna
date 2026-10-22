import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Portals do not render on the server. Keep the real dialog context and content.
const modal = await import('../../primitives/modal');
mock.module('../../primitives/modal', () => ({
  ...modal,
  ModalContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const { ConnectMcpModal, mcpUrl } = await import('./connect-mcp-modal');
const { platformConfig } = await import('@kortix/sdk');

test('Connect MCP shows the endpoint as selectable text beside a copy action', () => {
  const html = renderToStaticMarkup(<ConnectMcpModal open onOpenChange={() => {}} />);
  const url = mcpUrl(platformConfig().backendUrl);
  // A deep link containing the URL is not visible endpoint text.
  expect(html).toContain(`>${url}</code>`);
  expect(html).toContain('Copy URL');
});
