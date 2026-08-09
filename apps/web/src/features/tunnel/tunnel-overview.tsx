'use client';

import { formatRelative } from '@kortix/shared';
import {
  MagnifyingGlassIcon,
  MonitorIcon,
  PlugsConnectedIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { InlineMeta } from '@/components/ui/inline-meta';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import {
  useDeleteTunnelConnection,
  useTunnelConnections,
  type TunnelConnection,
} from '@/hooks/tunnel/use-tunnel';
import { useTunnelRealtimeSync } from '@/hooks/tunnel/use-tunnel-realtime';
import { cn } from '@/lib/utils';
import { ConnectCommandPanel } from './tunnel-connect-panel';
import { TunnelPermissionRequestDialog } from './tunnel-permission-request-dialog';
import { TunnelSettingsDialog } from './tunnel-settings-dialog';

function LoadingSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-14 rounded-md" />
      ))}
    </div>
  );
}

export interface ComputerTunnelManagerProps {
  canWrite?: boolean;
  selectedIds?: readonly string[];
  onSelectedIdsChange?: (ids: string[]) => void;
  selectionDisabled?: boolean;
  /** Restrict a read-only profile to its assigned machines. */
  visibleIds?: readonly string[];
}

/**
 * Canonical Computer Tunnel management surface.
 *
 * Create-profile and edit-profile flows use this same component. Pairing,
 * search, selection, settings, permission, audit, and deletion behavior cannot
 * drift between a connector profile and a separate fleet page.
 */
export function ComputerTunnelManager({
  canWrite = false,
  selectedIds,
  onSelectedIdsChange,
  selectionDisabled = false,
  visibleIds,
}: ComputerTunnelManagerProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: allConnections = [], isLoading } = useTunnelConnections();
  const deleteMutation = useDeleteTunnelConnection();
  useTunnelRealtimeSync();

  const [selectedTunnel, setSelectedTunnel] = useState<TunnelConnection | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TunnelConnection | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const visible = useMemo(() => (visibleIds ? new Set(visibleIds) : null), [visibleIds]);
  const connections = useMemo(
    () =>
      visible === null
        ? allConnections
        : allConnections.filter((connection) => visible.has(connection.tunnelId)),
    [allConnections, visible],
  );
  const selected = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
  const selectable = selectedIds !== undefined && onSelectedIdsChange !== undefined;
  const hasConnections = connections.length > 0;

  const filtered = searchQuery
    ? connections.filter(
        (connection) =>
          connection.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (connection.machineInfo as Record<string, string>)?.hostname
            ?.toLowerCase()
            .includes(searchQuery.toLowerCase()),
      )
    : connections;

  const handleDelete = async (tunnelId: string) => {
    try {
      await deleteMutation.mutateAsync(tunnelId);
      successToast('Computer Tunnel deleted');
      setDeleteTarget(null);
      if (selectable && selected.has(tunnelId)) {
        onSelectedIdsChange(selectedIds.filter((id) => id !== tunnelId));
      }
      if (selectedTunnel?.tunnelId === tunnelId) {
        setSelectedTunnel(null);
        setSettingsOpen(false);
      }
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Failed to delete Computer Tunnel');
    }
  };

  const handleSelect = (connection: TunnelConnection) => {
    setSelectedTunnel(connection);
    setSettingsOpen(true);
  };

  const toggleAssignment = (tunnelId: string, checked: boolean) => {
    if (!selectable) return;
    const next = new Set(selected);
    if (checked) next.add(tunnelId);
    else next.delete(tunnelId);
    onSelectedIdsChange([...next]);
  };

  return (
    <>
      <div className="space-y-5">
        {hasConnections && canWrite ? <ConnectCommandPanel /> : null}

        <div className="space-y-4">
          {hasConnections ? (
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <MagnifyingGlassIcon />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder={tHardcodedUi.raw(
                  'componentsTunnelTunnelOverview.line348JsxAttrPlaceholderSearchConnections',
                )}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                variant="popover"
              />
              <InputGroupSearchClear onClick={() => setSearchQuery('')} />
            </InputGroupSearch>
          ) : null}

          {isLoading ? (
            <LoadingSkeleton />
          ) : !hasConnections ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PlugsConnectedIcon />
                </EmptyMedia>
                <EmptyTitle>Pair a computer</EmptyTitle>
                <EmptyDescription>
                  Run the Agent Tunnel command on a Mac, Windows PC, or Linux machine. Approve the
                  device code in your browser to add it to this profile.
                </EmptyDescription>
              </EmptyHeader>
              {canWrite ? (
                <EmptyContent className="max-w-md">
                  <ConnectCommandPanel />
                </EmptyContent>
              ) : null}
            </Empty>
          ) : filtered.length === 0 && searchQuery ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              No Computer Tunnels match{' '}
              <span className="text-foreground font-mono">{searchQuery}</span>.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {selectable ? <TableHead className="w-10" aria-label="Assigned" /> : null}
                  <TableHead className="size-8 p-0" />
                  <TableHead>Name</TableHead>
                  <TableHead>Host</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((connection) => {
                  const isOnline = connection.isLive;
                  const machineInfo = connection.machineInfo as Record<string, string> | undefined;
                  const platformLabel = machineInfo?.platform
                    ? `${machineInfo.platform}${machineInfo.arch ? ` ${machineInfo.arch}` : ''}`.trim()
                    : null;
                  const lastSeen = connection.lastHeartbeatAt
                    ? (formatRelative(connection.lastHeartbeatAt, { maxRelativeDays: null }) ??
                      'unknown')
                    : 'Never';

                  return (
                    <TableRow
                      key={connection.tunnelId}
                      className="cursor-pointer"
                      onClick={() => handleSelect(connection)}
                    >
                      {selectable ? (
                        <TableCell className="w-10" onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            checked={selected.has(connection.tunnelId)}
                            disabled={selectionDisabled}
                            aria-label={`Assign ${connection.name}`}
                            onCheckedChange={(checked) =>
                              toggleAssignment(connection.tunnelId, checked === true)
                            }
                          />
                        </TableCell>
                      ) : null}
                      <TableCell className="size-8 pr-0 pl-4">
                        <span
                          className={cn(
                            'inline-flex size-8 shrink-0 items-center justify-center rounded-sm',
                            isOnline
                              ? 'bg-kortix-green/15 text-kortix-green'
                              : 'bg-primary/5 text-muted-foreground',
                          )}
                        >
                          <MonitorIcon className="size-5 shrink-0" weight="fill" />
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{connection.name}</p>
                          <p className="text-muted-foreground font-mono text-xs">
                            {connection.tunnelId.slice(0, 8)}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm whitespace-normal">
                        {machineInfo?.hostname || platformLabel ? (
                          <InlineMeta>
                            {machineInfo?.hostname}
                            {platformLabel}
                          </InlineMeta>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs tabular-nums">
                        {lastSeen}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      <TunnelSettingsDialog
        tunnel={selectedTunnel}
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSelectedTunnel(null);
        }}
        canWrite={canWrite}
        onDelete={canWrite ? () => selectedTunnel && setDeleteTarget(selectedTunnel) : undefined}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Computer Tunnel"
        description={
          <>
            This permanently disconnects{' '}
            <span className="text-foreground font-medium">{deleteTarget?.name}</span> and revokes
            its active permissions. Existing audit events remain available.
          </>
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        confirmIcon={<TrashIcon className="size-3.5 shrink-0" weight="fill" />}
        isPending={deleteMutation.isPending}
        onConfirm={() => deleteTarget && void handleDelete(deleteTarget.tunnelId)}
      />

      <TunnelPermissionRequestDialog />
    </>
  );
}

export function TunnelOverview({ canWrite = false }: { canWrite?: boolean }) {
  return (
    <CustomizeSectionWrapper
      title="Computer Tunnels"
      description="Pair Macs, Windows PCs, and Linux machines through the secure Kortix Agent Tunnel. Open a machine to control its permissions and review its audit history."
    >
      <ComputerTunnelManager canWrite={canWrite} />
    </CustomizeSectionWrapper>
  );
}
