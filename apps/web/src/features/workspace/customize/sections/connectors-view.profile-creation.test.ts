import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'connectors-view.tsx'), 'utf8');
const modalSource = readFileSync(join(import.meta.dir, 'connector-profile-modal.tsx'), 'utf8');

describe('connector profile creation controls', () => {
  test('opens an Easy Connect profile form before creating the connector', () => {
    expect(source).toContain('buildEasyConnectProfileDraft(selectedApp,');
    expect(source).toContain('<ConnectorProfileModal');
    expect(source).toContain('idPrefix="easy-connect-profile"');
    expect(source).toContain('proposeConnectorProfileSlug(selectedApp.name, existingSlugs)');
    expect(modalSource).toContain('id={`${idPrefix}-name`}');
    expect(modalSource).toContain('id={`${idPrefix}-slug`}');
    expect(modalSource).toContain('maxLength={255}');
    expect(modalSource).toContain('aria-describedby={slugDescriptionId}');
    expect(modalSource).toContain("role={slug.length > 0 && !slugAvailable ? 'alert' : undefined}");
  });

  test('collects an authorization strategy for custom connectors', () => {
    expect(source).toContain("authorization_strategy: 'project'");
    expect(source).toContain('idPrefix="custom-connector"');
  });

  test('edits an existing connector authorization strategy through the SDK', () => {
    expect(source).toContain('setConnectorAuthorizationStrategy(');
    expect(source).toContain('value={connector.authorizationStrategy}');
  });

  test('uses only the authorization owner allowed by the selected strategy', () => {
    expect(source).toContain('profile.owner_type === authorizationOwnerType');
    expect(source).toContain("authorizationOwnerType === 'project' && canManageProfiles");
    expect(source).toContain("authorizationOwnerType === 'member' && (");
    expect(source).toContain("authorizationStrategy === 'user'");
    expect(source).toContain('reconcileMemberConnectorAuthorization(');
    expect(source).toContain('updateConnectorAuthorizationCredential(');
    expect(source).toContain(
      "enabled: open && Boolean(connector) && authorizationStrategy === 'project'",
    );
    expect(source).toContain('connector?.requestAuthType');
  });

  test('locks managed providers and invalidates authorization consumers', () => {
    expect(source).toContain('connectorAuthorizationStrategyIsEditable(');
    expect(source).toContain('connectorAuthorizationStrategyForProvider(');
    expect(source).toContain('connectorAuthorizationQueryKeys(projectId)');
    expect(source).toContain('for (const affectedQueryKey of authorizationQueryKeys)');
  });

  test('shows member authorization controls only for user-owned profiles', () => {
    expect(source).toContain(
      "showConnections && canManageProfiles && connector.authorizationStrategy === 'user'",
    );
    expect(source).toContain(
      'profile.owner_type === authorizationOwnerTypeForStrategy(connector.authorizationStrategy)',
    );
  });

  test('surfaces connector synchronization errors after strategy updates', () => {
    expect(source).toContain('result.sync?.errors.find((error) => error.slug === connector.slug)');
    expect(source).toContain('Authorization owner changed, but synchronization failed:');
  });

  test('does not use shared OAuth credentials for user-owned custom profiles', () => {
    expect(source).toContain("oauth2Selected && effectiveAuthorizationStrategy === 'project'");
    expect(source).toContain(
      "effectiveAuthorizationStrategy === 'project' ? setOauth2Selected : undefined",
    );
    expect(source).toContain('Each user then stores their own private credential');
  });

  test('does not load manager-only connector configuration for read-only users', () => {
    expect(source).toContain('const showProfileTab = canWrite && !isPipedream && !isManaged;');
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
