import { readFileSync } from '@/i18n/test-source';
import { describe, expect, test } from 'bun:test';
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

  // A custom connector's draft no longer collects an authorization strategy —
  // ownership is an ACCOUNT property (`owner_type`), set per connection, not a
  // connector-level mode chosen at creation. `ConnectorConnectionModal` (the
  // "Add connector" dialog) has no owner field either — see its own docstring:
  // "There is no owner choice here any more."
  test('the custom-connector draft carries no authorization strategy', () => {
    expect(source).not.toContain("authorization_strategy: 'project'");
    expect(source).not.toContain('idPrefix="custom-connector"');
    expect(source).not.toContain('AuthorizationStrategyField');
    expect(modalSource).not.toContain('AuthorizationStrategyField');
  });

  // `connectors.authorization_strategy` is now a DERIVED, read-only summary
  // the API computes from a connector's accounts — nothing in this file
  // mutates it any more. `setConnectorAuthorizationStrategy` stays imported
  // (deprecated, still wired server-side as a no-op) but is never called here.
  test('never mutates the deprecated authorization strategy from this file', () => {
    expect(source).not.toContain('setConnectorAuthorizationStrategy(');
    expect(source).not.toContain('updateAuthorizationStrategy.mutate(');
  });

  // `SetCredentialModal` takes an explicit `owner: 'project' | 'me'` now
  // (renamed from `authorizationStrategy`), and branches the connection
  // resolution on it — `reconcileMemberConnection` for `'me'`,
  // `ensureProjectConnectorConnection` otherwise.
  test('SetCredentialModal resolves the connection by explicit owner', () => {
    expect(source).toContain("owner === 'me'");
    expect(source).toContain('reconcileMemberConnection(');
    expect(source).toContain('updateConnectionCredential(');
    expect(source).toContain("enabled: open && Boolean(connector) && owner === 'project'");
    expect(source).toContain('connector?.requestAuthType');
  });

  test('surfaces connector synchronization errors after adding a connector', () => {
    expect(source).toContain('connectorSyncErrorForSlug(result, draft.slug)');
    expect(source).toContain("tI18nHardcoded('i18nComplete.textd6a135de3872'");
  });

  // OAuth2-at-creation is offered unconditionally now (no more owner-strategy
  // gate) — only a channel connector has no offer, since channels have no
  // OAuth2-at-creation flow at all.
  test('offers OAuth2 credentials for every non-channel custom connector', () => {
    expect(source).toContain('oauth2Selected={oauth2Selected}');
    expect(source).toContain('onOAuth2SelectedChange={setOauth2Selected}');
    expect(source).toContain("if (draft.provider === 'channel' && oauth2Selected)");
    expect(source).not.toContain('effectiveAuthorizationStrategy');
  });

  // `ConnectorsView`, `ConnectorsMasterDetail`, `ConnectorDetail`, and
  // `PermissionsSection` were the legacy master-detail shell: 0 importers in
  // apps/web/src, unreachable from the live route (`connectors-page.tsx`
  // mounts the new catalog instead). Deleted as dead code, along with the
  // helpers only they used (`ruleId`/`_rid`, `isPatternMatch`, `clientMatch`,
  // `policiesSig`, `tsSignature`, `PermissionPicker`, `GlobalRulesPanel`,
  // `ConnectorRail`, `statusDot`, `MasterDetailSkeleton`, and the
  // `connectorConnectionQueryKeys`-driven multi-key invalidation on
  // selection change). This asserts the shell stays gone rather than
  // creeping back in.
  test('the legacy ConnectorDetail shell is gone', () => {
    expect(source).not.toContain('export function ConnectorDetail');
    expect(source).not.toContain('export function ConnectorsView');
    expect(source).not.toContain('export function PermissionsSection');
    expect(source).not.toContain('strategyUpdating');
  });
});
