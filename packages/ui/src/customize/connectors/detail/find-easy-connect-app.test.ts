import { describe, expect, test } from 'bun:test';

import { findEasyConnectApp } from './find-easy-connect-app';

const app = (slug: string, name: string) => ({ slug, name });

describe('findEasyConnectApp', () => {
  test('finds the app whose slug matches exactly', async () => {
    const queries: string[] = [];
    const found = await findEasyConnectApp(
      async ({ q }) => {
        queries.push(q);
        return { apps: [app('github_enterprise', 'GitHub Enterprise'), app('github', 'GitHub')] };
      },
      { projectId: 'p1', provider: 'composio', slug: 'github' },
    );
    expect(found?.slug).toBe('github');
    expect(found?.provider).toBe('composio');
    expect(queries).toEqual(['github']);
  });

  test('retries with the slug spelled as words when the search missed', async () => {
    const queries: string[] = [];
    const found = await findEasyConnectApp(
      async ({ q }) => {
        queries.push(q);
        return { apps: q === 'google sheets' ? [app('google_sheets', 'Google Sheets')] : [] };
      },
      { projectId: 'p1', provider: 'pipedream', slug: 'google_sheets' },
    );
    expect(found?.name).toBe('Google Sheets');
    expect(queries).toEqual(['google_sheets', 'google sheets']);
  });

  test('a slug with no separator is searched once', async () => {
    const queries: string[] = [];
    const found = await findEasyConnectApp(
      async ({ q }) => {
        queries.push(q);
        return { apps: [] };
      },
      { projectId: 'p1', provider: 'composio', slug: 'resend' },
    );
    expect(found).toBeNull();
    expect(queries).toEqual(['resend']);
  });
});
