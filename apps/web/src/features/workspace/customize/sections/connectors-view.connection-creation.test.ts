import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'connectors-view.tsx'), 'utf8');
const modalSource = readFileSync(join(import.meta.dir, 'connector-connection-modal.tsx'), 'utf8');

describe('connection creation controls', () => {
  test('opens an Easy Connect connection form before creating the connector', () => {
    expect(source).toContain('buildEasyConnectConnectorDraft(selectedApp,');
    expect(source).toContain('<ConnectorConnectionModal');
    expect(source).toContain('idPrefix="easy-connect-connector"');
    expect(source).toContain('proposeConnectorConnectionSlug(selectedApp.name, existingSlugs)');
    expect(modalSource).toContain('id={`${idPrefix}-name`}');
    expect(modalSource).toContain('id={`${idPrefix}-slug`}');
    expect(modalSource).toContain('maxLength={255}');
    expect(modalSource).toContain('aria-describedby={slugDescriptionId}');
    expect(modalSource).toContain("role={slug.length > 0 && !slugAvailable ? 'alert' : undefined}");
  });

  test('collects an authorization strategy for custom connectors', () => {
    expect(source).toContain("authorization_strategy: 'workspace'");
    expect(source).toContain('idPrefix="custom-connector"');
  });

  test('edits an existing connector authorization strategy through the SDK', () => {
    expect(source).toContain('setConnectorAuthorizationStrategy(');
    expect(source).toContain('value={connector.authorizationStrategy}');
  });

  test('uses only the authorization owner allowed by the selected strategy', () => {
    expect(source).toContain('connection.owner_type === connectionOwnerType');
    expect(source).toContain("connectionOwnerType === 'workspace' && canManageConnections");
    expect(source).toContain("connectionOwnerType === 'member' && (");
    expect(source).toContain("authorizationStrategy === 'user'");
    expect(source).toContain('reconcileMemberConnection(');
    expect(source).toContain('updateConnectionCredential(');
    expect(source).toContain(
      "enabled: open && Boolean(connector) && authorizationStrategy === 'workspace'",
    );
    expect(source).toContain('connector?.requestAuthType');
  });

  test('locks managed providers and invalidates authorization consumers', () => {
    expect(source).toContain('connectorAuthorizationStrategyIsEditable(');
    expect(source).toContain('connectorAuthorizationStrategyForProvider(');
    expect(source).toContain('connectorConnectionQueryKeys(workspaceId)');
    expect(source).toContain('for (const affectedQueryKey of connectionQueryKeys)');
  });

  test('shows member connection controls only for user-owned connectors', () => {
    expect(source).toContain(
      "showConnections && canManageConnections && connector.authorizationStrategy === 'user'",
    );
    expect(source).toContain(
      'connection.owner_type === connectionOwnerTypeForStrategy(connector.authorizationStrategy)',
    );
  });

  test('surfaces connector synchronization errors after strategy updates', () => {
    expect(source).toContain('result.sync?.errors.find((error) => error.slug === connector.slug)');
    expect(source).toContain('Authorization owner changed, but synchronization failed:');
  });

  test('does not use shared OAuth credentials for user-owned custom connectors', () => {
    expect(source).toContain("oauth2Selected && effectiveAuthorizationStrategy === 'workspace'");
    expect(source).toContain(
      "effectiveAuthorizationStrategy === 'workspace' ? setOauth2Selected : undefined",
    );
    expect(source).toContain('Each user then stores their own private credential');
  });

  test('does not load manager-only connector configuration for read-only users', () => {
    expect(source).toContain('const showConnectionTab = canWrite && !isPipedream && !isManaged;');
    expect(source).toContain('const showPermissions = canWrite;');
    expect(source).toContain('enabled: canWrite');
  });

  test('locks connector actions while the authorization strategy is updating', () => {
    expect(source).toContain('connectorAuthorizationUpdateIsPending(');
    expect(source).toContain(
      'authorizationStrategyAwaitingRefresh === connector.authorizationStrategy',
    );
    expect(source).toContain('disabled={strategyUpdating}');
    expect(source).toContain('disabled={reconnect.isPending || strategyUpdating}');
  });
});
