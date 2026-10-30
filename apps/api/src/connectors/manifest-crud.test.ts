import { describe, expect, test } from 'bun:test';
import { mergeConnectorDraftEntry, type ConnectorDraft } from './manifest-crud';

const baseDraft: ConnectorDraft = {
  slug: 'gmail',
  provider: 'pipedream',
  app: 'gmail',
};

describe('mergeConnectorDraftEntry', () => {
  test('preserves the stored authorization strategy when a partial edit omits it', () => {
    expect(
      mergeConnectorDraftEntry(baseDraft, {
        slug: 'gmail',
        name: 'Personal Gmail',
        provider: 'pipedream',
        app: 'gmail',
        authorization_strategy: 'user',
      }),
    ).toEqual({
      slug: 'gmail',
      name: 'Personal Gmail',
      provider: 'pipedream',
      app: 'gmail',
      authorization_strategy: 'user',
    });
  });

  test('replaces the authorization strategy when the edit supplies it', () => {
    expect(
      mergeConnectorDraftEntry(
        { ...baseDraft, authorization_strategy: 'project' },
        {
          slug: 'gmail',
          provider: 'pipedream',
          app: 'gmail',
          authorization_strategy: 'user',
        },
      ).authorization_strategy,
    ).toBe('project');
  });

  test('keeps the sensitive flag when an edit replaces the entry, as a Pipedream move does', () => {
    expect(
      mergeConnectorDraftEntry(
        { slug: 'gmail', provider: 'mcp', url: 'https://gmailmcp.googleapis.com/mcp/v1', transport: 'http' },
        { slug: 'gmail', provider: 'pipedream', app: 'gmail', sensitive: true },
      ),
    ).toEqual({ slug: 'gmail', provider: 'mcp', url: 'https://gmailmcp.googleapis.com/mcp/v1', transport: 'http', sensitive: true });
  });
});
