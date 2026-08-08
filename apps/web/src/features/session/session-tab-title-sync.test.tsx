import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionTabTitleSync } from './session-tab-title-sync';

describe('SessionTabTitleSync', () => {
  test('does not require a default query function to subscribe to cached sessions', () => {
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <SessionTabTitleSync projectId="workspace-1" sessionId="session-1" />
        </QueryClientProvider>,
      );
    } finally {
      console.error = originalError;
    }

    expect(errors).toEqual([]);
  });
});
