import {
  createConnector,
  deleteConnector,
  listConnections,
  reconcileConnection,
  reconcileMemberConnection,
  setConnectorCredential,
} from '@kortix/sdk';

import { createConnectorWithOptionalOAuth2 } from '../../sections/connector-oauth2';
import { startDiscoveredSignIn } from '../../sections/connector-oauth2-start';
import { connectorConnectionRows } from '../../sections/view/connector-connections';
import { grantConnectionAccess } from '../../../access/access/access-dialog-share';

import type { AddMcpServerDeps } from './add-mcp-server';

/** `addMcpServer` over the SDK. `accountId` is the account "Specific people" grants are written in. */
export function sdkAddMcpServerDeps(accountId: string | null | undefined): AddMcpServerDeps {
  return {
    createConnector: (pid, draft) =>
      createConnectorWithOptionalOAuth2(pid, draft, null, {
        createConnector,
        deleteConnector,
        setConnectorCredential,
      }),
    createMemberAccount: reconcileMemberConnection,
    projectAccount: async (pid, slug, label) => {
      // The connector's own shared account, made with it: sign that one
      // in, so it stays the connector's default.
      const { connections } = await listConnections(pid);
      const made = connectorConnectionRows(connections, slug).find(
        (row) => row.owner_type === 'project',
      );
      return made ?? reconcileConnection(pid, { connector_alias: slug, owner_type: 'project', label });
    },
    grantAccess: (pid, connectionId, grantees) =>
      grantConnectionAccess(accountId ?? '', pid, connectionId, grantees),
    startSignIn: startDiscoveredSignIn,
  };
}
