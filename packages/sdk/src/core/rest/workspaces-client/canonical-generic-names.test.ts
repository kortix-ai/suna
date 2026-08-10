import { expect, test } from 'bun:test';

import type {
  WorkspaceAccountDetail,
  WorkspaceAccountMember,
  WorkspaceAccountToken,
  WorkspaceAdminConnector,
  WorkspaceApp,
  WorkspaceAppAccessConfig,
  WorkspaceAppAccessMode,
  WorkspaceAuditEvent,
  WorkspaceChangeRequest,
  WorkspaceConnectorAuthorizationStrategy,
  WorkspaceConnectorConfig,
  WorkspaceConnectorDraftInput,
  WorkspaceConnectorSharing,
  WorkspaceCreatedAccountToken,
  WorkspaceGatewayBudgetRow,
  WorkspaceGatewayRoutingPolicyDocument,
  WorkspaceSandboxProviderTransitionState,
  WorkspaceSandboxProviderTransitionView,
  WorkspaceSessionAudit,
  WorkspaceSessionPublicShare,
} from '../../../index';

test('canonical generic Workspace types are available from the public root', () => {
  const exportedTypes: [
    WorkspaceAccountDetail?,
    WorkspaceAccountMember?,
    WorkspaceAccountToken?,
    WorkspaceAdminConnector?,
    WorkspaceApp?,
    WorkspaceAppAccessConfig?,
    WorkspaceAppAccessMode?,
    WorkspaceAuditEvent?,
    WorkspaceChangeRequest?,
    WorkspaceConnectorAuthorizationStrategy?,
    WorkspaceConnectorConfig?,
    WorkspaceConnectorDraftInput?,
    WorkspaceConnectorSharing?,
    WorkspaceCreatedAccountToken?,
    WorkspaceGatewayBudgetRow?,
    WorkspaceGatewayRoutingPolicyDocument?,
    WorkspaceSandboxProviderTransitionState?,
    WorkspaceSandboxProviderTransitionView?,
    WorkspaceSessionAudit?,
    WorkspaceSessionPublicShare?,
  ] = [];

  expect(exportedTypes).toEqual([]);
});
