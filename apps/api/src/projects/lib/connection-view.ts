/** The public `Connection` view shared by the connection routes. */
import { ConnectionSchema, type ComputerMachineStatus } from '@kortix/api-contract';
import { tunnelConnections } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { connectedAsOf } from '../../connectors/connection-identity';
import { db } from '../../shared/db';
import { isTunnelConnectionLive } from '../../tunnel/core/cluster-forwarder';

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

/** Live status of each paired machine, by tunnel id. One query. */
export async function loadComputerMachines(
  tunnelIds: readonly (string | null)[],
): Promise<Map<string, ComputerMachineStatus>> {
  const ids = [...new Set(tunnelIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      tunnelId: tunnelConnections.tunnelId,
      status: tunnelConnections.status,
      machineInfo: tunnelConnections.machineInfo,
      lastHeartbeatAt: tunnelConnections.lastHeartbeatAt,
      relayOwnerId: tunnelConnections.relayOwnerId,
      relayOwnerHeartbeatAt: tunnelConnections.relayOwnerHeartbeatAt,
    })
    .from(tunnelConnections)
    .where(inArray(tunnelConnections.tunnelId, ids));
  return new Map(
    rows.map((row) => {
      const info = (row.machineInfo ?? {}) as Record<string, unknown>;
      return [
        row.tunnelId,
        {
          online: isTunnelConnectionLive(row),
          last_heartbeat_at: row.lastHeartbeatAt?.toISOString() ?? null,
          ...(typeof info.hostname === 'string' ? { hostname: info.hostname } : {}),
          ...(typeof info.platform === 'string' ? { platform: info.platform } : {}),
        },
      ];
    }),
  );
}

/** `tunnel_id` + `machine` for a computer account; nothing for any other connector. */
export function computerConnectionFields(
  row: { providerType: string; tunnelId: string | null },
  machines: ReadonlyMap<string, ComputerMachineStatus>,
): { tunnel_id: string | null; machine: ComputerMachineStatus | null } | Record<string, never> {
  if (row.providerType !== 'computer') return {};
  return {
    tunnel_id: row.tunnelId,
    machine: (row.tunnelId && machines.get(row.tunnelId)) || null,
  };
}
