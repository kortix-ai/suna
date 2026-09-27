/** The public `Connection` view shared by the connection routes. */
import { ConnectionSchema } from '@kortix/api-contract';
import { connectedAsOf } from '../../connectors/connection-identity';

// Keep the existing OpenAPI component id for generated-client compatibility.
export const ConnectionViewSchema = ConnectionSchema.openapi('Connection');

export function serializeConnection(row: {
  connectionId: string;
  connectorAlias: string;
  ownerType: string;
  ownerId: string | null;
  label: string;
  status: string;
  isDefault: boolean;
  metadata: Record<string, unknown>;
}) {
  return {
    connection_id: row.connectionId,
    connector_alias: row.connectorAlias,
    owner_type: row.ownerType,
    owner_id: row.ownerId,
    label: row.label,
    status: row.status,
    is_default: row.isDefault,
    metadata: row.metadata ?? {},
    connected_as: connectedAsOf(row.metadata),
  };
}
