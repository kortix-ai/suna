'use client';

import { TrashSolid } from '@mynaui/icons-react';
import { Check, Copy, Info, Monitor, MoreHorizontal, ScrollText, Shield } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTunnelConnection, type TunnelConnection } from '@/hooks/tunnel/use-tunnel';
import { useCopy } from '@/hooks/use-copy';
import { cn } from '@/lib/utils';
import { TunnelAuditTable } from './tunnel-audit-table';
import { TunnelScopeToggles } from './tunnel-scope-toggles';

interface TunnelSettingsDialogProps {
  tunnel: TunnelConnection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete?: () => void;
}

type SettingsTab = 'permissions' | 'audit' | 'connection';

export function TunnelSettingsDialog({
  tunnel,
  open,
  onOpenChange,
  onDelete,
}: TunnelSettingsDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: liveData } = useTunnelConnection(tunnel?.tunnelId || '');
  const conn = liveData || tunnel;
  const tunnelId = conn?.tunnelId;
  const [activeTab, setActiveTab] = useState<SettingsTab>('permissions');

  useEffect(() => {
    if (open) {
      setActiveTab('permissions');
    }
  }, [open, tunnelId]);

  if (!conn) return null;

  const isOnline = conn.isLive;
  const machineInfo = conn.machineInfo as Record<string, string> | undefined;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        className="flex max-h-[min(85vh,720px)] flex-col gap-0 overflow-hidden p-0 lg:max-w-2xl"
        modalClassName="lg:max-w-2xl"
      >
        <ModalHeader>
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'inline-flex size-8 shrink-0 items-center justify-center rounded-sm border',
                isOnline
                  ? 'bg-kortix-green/10 text-kortix-green'
                  : 'text-muted-foreground border-border',
              )}
            >
              <Monitor className="size-5 shrink-0" />
            </div>
            <ModalTitle className="text-balance">{conn.name}</ModalTitle>
            {onDelete ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="More actions"
                    className="shrink-0 transition-transform active:scale-[0.96]"
                  >
                    <MoreHorizontal className="size-4 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={onDelete} variant="destructive">
                    <TrashSolid className="shrink-0" />
                    Delete connection
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </ModalHeader>

        <ModalBody className="flex min-h-0 flex-1 flex-col gap-0">
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as SettingsTab)}
            className="flex min-h-0 flex-1 flex-col gap-0 space-y-4"
          >
            <TabsList className="w-fit shrink-0">
              <TabsTrigger value="permissions">
                <Shield className="size-3.5 shrink-0" />
                Permissions
              </TabsTrigger>
              <TabsTrigger value="audit">
                <ScrollText className="size-3.5 shrink-0" />
                {tHardcodedUi.raw('componentsTunnelTunnelSettingsDialog.line138JsxTextAuditLog')}
              </TabsTrigger>
              <TabsTrigger value="connection">
                <Info className="size-3.5 shrink-0" />
                Connection
              </TabsTrigger>
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <TabsContent value="permissions">
                {activeTab === 'permissions' && tunnelId ? (
                  <TunnelScopeToggles tunnelId={tunnelId || ''} />
                ) : null}
              </TabsContent>

              <TabsContent value="audit">
                {activeTab === 'audit' ? <TunnelAuditTable tunnelId={conn.tunnelId} /> : null}
              </TabsContent>

              <TabsContent value="connection">
                {activeTab === 'connection' ? <ConnectionInfoTab connection={conn} /> : null}
              </TabsContent>
            </div>
          </Tabs>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function ConnectionInfoTab({ connection }: { connection: TunnelConnection }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { copied, copy } = useCopy({ successMessage: 'Tunnel ID copied' });
  const machineInfo = connection.machineInfo as Record<string, string> | undefined;
  const isOnline = connection.isLive;
  const capabilities = connection.capabilities || [];

  const rows: { label: string; value: ReactNode }[] = [
    {
      label: 'Tunnel ID',
      value: (
        <div className="flex min-w-0 items-center justify-end gap-2">
          <span className="truncate font-mono text-xs">{connection.tunnelId}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={tHardcodedUi.raw(
              'componentsTunnelTunnelSettingsDialog.line243JsxAttrAriaLabelCopyTunnelId',
            )}
            className="shrink-0 transition-transform active:scale-[0.96]"
            onClick={() => copy(connection.tunnelId)}
          >
            {copied ? (
              <Check className="text-kortix-green size-3.5 shrink-0" />
            ) : (
              <Copy className="text-muted-foreground size-3.5 shrink-0" />
            )}
          </Button>
        </div>
      ),
    },
    {
      label: 'Status',
      value: (
        <span className={cn('text-sm', isOnline ? 'text-kortix-green' : 'text-muted-foreground')}>
          {isOnline ? 'Online' : 'Offline'}
        </span>
      ),
    },
    { label: 'Hostname', value: machineInfo?.hostname || 'Unknown' },
    {
      label: 'Platform',
      value: machineInfo?.platform
        ? `${machineInfo.platform} ${machineInfo.arch || ''}`.trim()
        : 'Unknown',
    },
    { label: 'OS Version', value: machineInfo?.osVersion || 'Unknown' },
    { label: 'Agent Version', value: machineInfo?.agentVersion || 'Unknown' },
    {
      label: 'Capabilities',
      value:
        capabilities.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {capabilities.map((cap) => (
              <Badge key={cap} variant="secondary" size="sm">
                {cap}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground text-sm">None</span>
        ),
    },
    { label: 'Created', value: new Date(connection.createdAt).toLocaleString() },
  ];

  if (connection.lastHeartbeatAt) {
    rows.push({
      label: 'Last Heartbeat',
      value: (
        <span className="text-sm tabular-nums">
          {new Date(connection.lastHeartbeatAt).toLocaleString()}
        </span>
      ),
    });
  }

  return (
    <Table>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.label} className="hover:bg-transparent">
            <TableCell className="text-muted-foreground w-[34%] py-2 text-sm font-medium">
              {row.label}
            </TableCell>
            <TableCell className="py-2 text-right text-sm">
              {typeof row.value === 'string' ? (
                <span className={cn(row.label === 'Tunnel ID' && 'font-mono text-xs')}>
                  {row.value}
                </span>
              ) : (
                row.value
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
