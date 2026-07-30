import { describe, expect, test } from 'bun:test';

import { clearSessionFresh, isSessionFresh } from '@kortix/sdk/fresh-sessions';
import {
  marketplaceInstallSessionHref,
  prepareMarketplaceInstallSessionNavigation,
} from './marketplace-session-navigation';

describe('marketplace install session navigation', () => {
  test('builds the project-scoped session href', () => {
    expect(marketplaceInstallSessionHref('proj_123', 'sess_456')).toBe(
      '/projects/proj_123/sessions/sess_456',
    );
  });

  test('prepares the returned install session before navigation without marking it fresh', () => {
    const prefetchedRoutes: string[] = [];
    const prefetchedQueries: unknown[] = [];
    const invalidatedQueries: unknown[] = [];
    const queryClient = {
      prefetchQuery: (opts: unknown) => {
        prefetchedQueries.push(opts);
        return Promise.resolve();
      },
      invalidateQueries: (opts: unknown) => {
        invalidatedQueries.push(opts);
        return Promise.resolve();
      },
    };
    const sessionId = 'session-123';
    clearSessionFresh(sessionId);

    const href = prepareMarketplaceInstallSessionNavigation(
      queryClient as never,
      { prefetch: (route) => prefetchedRoutes.push(route) },
      'project-123',
      sessionId,
    );

    expect(href).toBe('/projects/project-123/sessions/session-123');
    // Marketplace install/setup sessions already carry a server-side
    // `initial_prompt`; marking them fresh would render the empty instant shell
    // instead of the actual install session.
    expect(isSessionFresh(sessionId)).toBe(false);
    expect(prefetchedRoutes).toEqual(['/projects/project-123/sessions/session-123']);
    expect(prefetchedQueries).toHaveLength(1);
    expect(invalidatedQueries).toEqual([{ queryKey: ['project-sessions', 'project-123'] }]);
  });

  test('returns null and does nothing when no session was created', () => {
    const queryClient = {
      prefetchQuery: () => {
        throw new Error('should not prefetch');
      },
      invalidateQueries: () => {
        throw new Error('should not invalidate');
      },
    };

    const href = prepareMarketplaceInstallSessionNavigation(
      queryClient as never,
      {
        prefetch: () => {
          throw new Error('should not prefetch route');
        },
      },
      'project-123',
      null,
    );

    expect(href).toBeNull();
  });
});
