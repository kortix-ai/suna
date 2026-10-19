import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import { qk } from '../../src/lib/query-keys';

// Render the select's public value without Radix's client-only portal.
mock.module('../../src/components/ui/select', () => ({
  Select: ({ value, disabled, children }: ComponentProps<'select'>) => (
    <select defaultValue={value} disabled={disabled}>{children}</select>
  ),
  SelectContent: ({ children }: ComponentProps<'div'>) => <>{children}</>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectItem: ({ value, disabled, children }: ComponentProps<'option'>) => (
    <option value={value} disabled={disabled}>{children}</option>
  ),
}));
const { SessionSharing } = await import('../../src/components/workbench/session-sharing');

for (const mode of ['members', 'private', 'project']) {
  test(`fresh mount displays persisted ${mode} sharing`, () => {
    const client = new QueryClient();
    client.setQueryData(qk.session('project-test', 'session-test'), {
      sharing: { mode, ownerId: 'owner-test' },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SessionSharing projectId="project-test" sessionId="session-test" selected={null} />
      </QueryClientProvider>,
    );
    expect(html).toContain(`value="${mode}"${mode === 'private' ? ' disabled=""' : ''} selected=""`);
    client.clear();
  });
}
