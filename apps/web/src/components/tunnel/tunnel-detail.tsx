'use client';

import { useTranslations } from 'next-intl';

/**
 * TunnelDetail — detailed view of a single tunnel connection.
 * Shows: connection info, permissions manager, audit log.
 */

import React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Monitor, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useTunnelConnection } from '@/hooks/tunnel/use-tunnel';
import { TunnelPermissionManager } from './tunnel-permission-manager';
import { TunnelAuditTable } from './tunnel-audit-table';
import { TunnelPermissionRequestDialog } from './tunnel-permission-request-dialog';
import { cn } from '@/lib/utils';

interface TunnelDetailProps {
  tunnelId: string;
}

export function TunnelDetail({ tunnelId }: TunnelDetailProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const { data: connection, isLoading } = useTunnelConnection(tunnelId);

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  }

  if (!connection) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsTunnelTunnelDetail.line35JsxTextTunnelConnectionNotFound')}</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => router.push('/tunnel')}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1" />{tHardcodedUi.raw('componentsTunnelTunnelDetail.line38JsxTextBackToTunnels')}</Button>
      </div>
    );
  }

  const isOnline = connection.isLive;
  const machineInfo = connection.machineInfo as Record<string, string> | undefined;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 pb-4 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.push('/tunnel')}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1" />
          Back
        </Button>

        <div className="flex items-start gap-4">
          <div className={cn(
            'flex h-12 w-12 items-center justify-center rounded-xl',
            isOnline ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground',
          )}>
            <Monitor className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">{connection.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              {isOnline ? (
                <Wifi className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className={cn(
                'text-sm',
                isOnline ? 'text-emerald-600' : 'text-muted-foreground',
              )}>
                {isOnline ? 'Connected' : 'Offline'}
              </span>
              {machineInfo?.hostname && (
                <span className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsTunnelTunnelDetail.line79JsxTextMiddot')}{machineInfo.hostname}
                </span>
              )}
            </div>

            {connection.capabilities.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {connection.capabilities.map((cap) => (
                  <Badge key={cap} variant="secondary" className="text-xs">{cap}</Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        <Tabs defaultValue="permissions" className="w-full">
          <TabsList>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            <TabsTrigger value="audit">{tHardcodedUi.raw('componentsTunnelTunnelDetail.line100JsxTextAuditLog')}</TabsTrigger>
          </TabsList>

          <TabsContent value="permissions" className="mt-4">
            <TunnelPermissionManager tunnelId={tunnelId} />
          </TabsContent>

          <TabsContent value="audit" className="mt-4">
            <TunnelAuditTable tunnelId={tunnelId} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Global Permission Request Dialog */}
      <TunnelPermissionRequestDialog />
    </div>
  );
}
