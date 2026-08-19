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
});
