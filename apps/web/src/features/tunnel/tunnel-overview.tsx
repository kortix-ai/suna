'use client';

import { formatRelative } from '@kortix/shared';
import { Cable, Check, Copy, Monitor, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
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
import { useCopy } from '@/hooks/use-copy';
import { getEnv } from '@/lib/env-config';
import { cn } from '@/lib/utils';
import { buildTunnelConnectCommand } from './tunnel-connect-command';
import { TunnelPermissionRequestDialog } from './tunnel-permission-request-dialog';
import { TunnelSettingsDialog } from './tunnel-settings-dialog';

function ConnectSteps() {
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <InlineMeta className="justify-center text-pretty">
      {tHardcodedUi.raw('componentsTunnelTunnelOverview.line203JsxTextText1RunTheCommand')}
      {tHardcodedUi.raw('componentsTunnelTunnelOverview.line205JsxTextText2ApproveInBrowser')}
      {tHardcodedUi.raw('componentsTunnelTunnelOverview.line207JsxTextText3Connected')}
    </InlineMeta>
  );
}

function ConnectCommandPanel() {
  const command = getConnectCommand();
  const { copied, copy } = useCopy({
    successMessage: 'Command copied',
    errorMessage: 'Copy failed',
    duration: 2000,
  });

  return (
    <div className="w-full space-y-4">
      <div className="bg-popover overflow-hidden rounded-md border">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <span className="text-muted-foreground text-xs">Install command</span>
        </div>
        <div className="bg-secondary relative rounded-t-md">
          <Button
            type="button"
            variant="accent"
            size="xs"
            onClick={() => copy(command)}
            className="absolute top-2 right-2 shrink-0"
          >
            {copied ? (
              <Check className="text-muted-foreground size-3.5" />
            ) : (
              <Copy className="text-muted-foreground size-3.5" />
            )}
          </Button>

          <pre className="text-foreground/90 overflow-x-auto px-4 py-3 text-left font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            {command}
          </pre>
        </div>
      </div>
      <ConnectSteps />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-10 rounded-md" />
      ))}
    </div>
  );
}

export function TunnelOverview({ canWrite = false }: { canWrite?: boolean }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: connections = [], isLoading } = useTunnelConnections();
  const deleteMutation = useDeleteTunnelConnection();
  useTunnelRealtimeSync();

  const [selectedTunnel, setSelectedTunnel] = useState<TunnelConnection | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TunnelConnection | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const hasConnections = connections.length > 0;

  const filtered = searchQuery
    ? connections.filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (c.machineInfo as Record<string, string>)?.hostname
            ?.toLowerCase()
            ?.includes(searchQuery.toLowerCase()),
      )
    : connections;

  const handleDelete = async (tunnelId: string) => {
    try {
      await deleteMutation.mutateAsync(tunnelId);
      successToast('Tunnel deleted');
      setDeleteTarget(null);
      if (selectedTunnel?.tunnelId === tunnelId) {
        setSelectedTunnel(null);
        setSettingsOpen(false);
      }
    } catch {
      errorToast('Failed to delete tunnel');
    }
  };

  const handleSelect = (conn: TunnelConnection) => {
    setSelectedTunnel(conn);
    setSettingsOpen(true);
  };

  return (
    <>
      <CustomizeSectionWrapper
        title="Computers"
        description="Connect local machines and grant agents permissioned access over a reverse tunnel."
      >
        {hasConnections && canWrite && (
          <div className="flex items-center justify-between gap-3">
            <ConnectCommandPanel />
          </div>
        )}

        <div className="space-y-4">
          {hasConnections && (
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <Search />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder={tHardcodedUi.raw(
                  'componentsTunnelTunnelOverview.line348JsxAttrPlaceholderSearchConnections',
                )}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                variant="popover"
              />
              <InputGroupSearchClear onClick={() => setSearchQuery('')} />
            </InputGroupSearch>
          )}

          {isLoading ? (
            <LoadingSkeleton />
          ) : !hasConnections ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Cable />
                </EmptyMedia>
                <EmptyTitle>
                  {tHardcodedUi.raw(
                    'componentsTunnelTunnelOverview.line234JsxTextConnectYourMachine',
                  )}
                </EmptyTitle>
                <EmptyDescription>
                  {tHardcodedUi.raw(
                    'componentsTunnelTunnelOverview.line236JsxTextRunThisCommandOnAnyMachineToConnect',
                  )}
                </EmptyDescription>
              </EmptyHeader>
              {canWrite && (
                <EmptyContent className="max-w-md">
                  <ConnectCommandPanel />
                </EmptyContent>
              )}
            </Empty>
          ) : filtered.length === 0 && searchQuery ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              {tHardcodedUi.raw(
                'componentsTunnelTunnelOverview.line362JsxTextNoConnectionsMatchingLdquo',
              )}
              <span className="text-foreground font-mono">{searchQuery}</span>
              {tHardcodedUi.raw('componentsTunnelTunnelOverview.line362JsxTextRdquo')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
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
                      <TableCell className="size-8 pr-0 pl-4">
                        <div
                          className={cn(
                            'inline-flex size-8 shrink-0 items-center justify-center rounded-sm border',
                            isOnline
                              ? 'bg-kortix-green/10 text-kortix-green'
                              : 'bg-kortix-red/10 text-kortix-red',
                          )}
                        >
                          <Monitor className="size-5 shrink-0" />
                        </div>
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
                      <TableCell className="text-muted-foreground text-xs">{lastSeen}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </CustomizeSectionWrapper>

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

      <DeleteConnectionDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && void handleDelete(deleteTarget.tunnelId)}
        isPending={deleteMutation.isPending}
      />

      <TunnelPermissionRequestDialog />
    </>
  );
}

function getConnectCommand(): string {
  return buildTunnelConnectCommand({
    backendUrl: getEnv().BACKEND_URL || '',
    origin: typeof window !== 'undefined' ? window.location.origin : '',
  });
}

function DeleteConnectionDialog({
  target,
  onClose,
  onConfirm,
  isPending,
}: {
  target: TunnelConnection | null;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <AlertDialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {tHardcodedUi.raw('componentsTunnelTunnelOverview.line126JsxTextDeleteConnection')}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {tHardcodedUi.raw(
                'componentsTunnelTunnelOverview.line128JsxTextThisWillPermanentlyDelete',
              )}
              {target ? <span className="text-foreground font-medium">{target.name}</span> : null}
              {tHardcodedUi.raw(
                'componentsTunnelTunnelOverview.line128JsxTextAndRemoveAllItsPermissionsAndAuditLogs',
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            disabled={isPending}
            onClick={onConfirm}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
