/**
 * Completing an OAuth connection must re-materialize the connector catalog.
 *
 * Without this, the MCP catalog fetched BEFORE the credential existed leaves
 * `status: 'error'` / `last_error: "MCP tools/list failed: HTTP 401"` on the
 * connector row. The user finishes the OAuth flow, sees "connected", and the
 * connector still reads **Error** with zero tools — the failure the whole
 * one-click flow was built to remove.
 */
import { describe, expect, test } from 'bun:test';
import { oauthCompletionRematerializeInput } from './oauth2-rematerialize';

describe('oauthCompletionRematerializeInput', () => {
  test('a project-owned default MCP connection re-materializes the catalog', () => {
    expect(
      oauthCompletionRematerializeInput({
        projectId: 'p1',
        accountId: 'a1',
        connectorId: 'c1',
        providerType: 'mcp',
        ownerType: 'project',
        isDefault: true,
      }),
    ).toEqual({
      projectId: 'p1',
      accountId: 'a1',
      provider: 'mcp',
      ownerType: 'project',
      isDefault: true,
      connectorId: 'c1',
    });
  });

  test('a member-owned or non-default connection never publishes a shared catalog', () => {
    expect(
      oauthCompletionRematerializeInput({
        projectId: 'p1',
        accountId: 'a1',
        connectorId: 'c1',
        providerType: 'mcp',
        ownerType: 'user',
        isDefault: true,
      }),
    ).toBeNull();
    expect(
      oauthCompletionRematerializeInput({
        projectId: 'p1',
        accountId: 'a1',
        connectorId: 'c1',
        providerType: 'mcp',
        ownerType: 'project',
        isDefault: false,
      }),
    ).toBeNull();
  });

  test('non-MCP providers have no credential-dependent catalog to refetch', () => {
    expect(
      oauthCompletionRematerializeInput({
        projectId: 'p1',
        accountId: 'a1',
        connectorId: 'c1',
        providerType: 'http',
        ownerType: 'project',
        isDefault: true,
      }),
    ).toBeNull();
  });
});
