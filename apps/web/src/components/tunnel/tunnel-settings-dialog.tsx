'use client';

/**
 * TunnelSettingsDialog — Radix Dialog replacing the slide-in panel.
 *
 * Tabs: Permissions | Audit Log | Connection
 */

import React from 'react';
import { Monitor, Wifi, WifiOff, Shield, ScrollText, Info, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTunnelConnection, type TunnelConnection } from '@/hooks/tunnel/use-tunnel';
import { TunnelPermissionManager } from './tunnel-permission-manager';
import { TunnelAuditTable } from './tunnel-audit-table';

interface TunnelSettingsDialogProps {
  tunnel: TunnelConnection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsTab = 'permissions' | 'audit' | 'connection';

export function TunnelSettingsDialog({ tunnel, open, onOpenChange }: TunnelSettingsDialogProps) {
  const { data: liveData } = useTunnelConnection(tunnel?.tunnelId || '');
  const conn = liveData || tunnel;
  const tunnelId = conn?.tunnelId;
  const [activeTab, setActiveTab] = React.useState<SettingsTab>('permissions');
  const contentInnerRef = React.useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = React.useState<number>(0);

  const measureContentHeight = React.useCallback(() => {
    const el = contentInnerRef.current;
    if (!el) return;
    setContentHeight(Math.ceil(el.getBoundingClientRect().height));
  }, []);

  const handleTabChange = React.useCallback((value: string) => {
    const el = contentInnerRef.current;
    if (el) {
      setContentHeight(Math.ceil(el.getBoundingClientRect().height));
    }
    setActiveTab(value as SettingsTab);
  }, []);

  React.useEffect(() => {
    if (!tunnelId) {
      setContentHeight(0);
      return;
    }

    const el = contentInnerRef.current;
    if (!el) return;

    measureContentHeight();
    const resizeObserver = new ResizeObserver(measureContentHeight);
    resizeObserver.observe(el);

    return () => resizeObserver.disconnect();
  }, [activeTab, tunnelId, measureContentHeight]);

  React.useEffect(() => {
    if (!open || !tunnelId) return;
    const raf = requestAnimationFrame(() => {
      measureContentHeight();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, tunnelId, activeTab, measureContentHeight]);

  if (!conn) return null;

  const isOnline = conn.isLive;
  const machineInfo = conn.machineInfo as Record<string, string> | undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 space-y-2">
          <div className="flex items-center gap-3">
            <div className={cn(
              'flex items-center justify-center w-10 h-10 rounded-xl border shrink-0',
              isOnline ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-muted border-border/50',
            )}>
              <Monitor className={cn('h-5 w-5', isOnline ? 'text-emerald-500' : 'text-foreground')} />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold">{conn.name}</DialogTitle>
              <DialogDescription className="flex items-center gap-1.5 mt-0.5">
                {isOnline ? (
                  <Wifi className="h-3 w-3 text-emerald-500" />
                ) : (
                  <WifiOff className="h-3 w-3" />
                )}
                <span className={cn('text-xs', isOnline ? 'text-emerald-600' : '')}>
                  {isOnline ? 'Online' : 'Offline'}
                </span>
                {machineInfo?.hostname && (
                  <span className="text-xs">· {machineInfo.hostname}</span>
                )}
              </DialogDescription>
            </div>
            <Badge
              variant="outline"
              className={cn(
                'shrink-0 gap-1.5 px-3 py-1 text-xs border',
                isOnline
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                  : 'bg-muted text-muted-foreground border-border/70',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', isOnline ? 'bg-emerald-500' : 'bg-muted-foreground/60')} />
              {isOnline ? 'Online' : 'Offline'}
            </Badge>
          </div>
        </DialogHeader>
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="w-full"
        >
          <div className="px-6 pt-2">
            <TabsList className="">
              <TabsTrigger value="permissions" className="flex-1">
                <Shield className="h-3.5 w-3.5" />
                Permissions
              </TabsTrigger>
              <TabsTrigger value="audit" className="flex-1">
                <ScrollText className="h-3.5 w-3.5" />
                Audit Log
              </TabsTrigger>
              <TabsTrigger value="connection" className="flex-1">
                <Info className="h-3.5 w-3.5" />
                Connection
              </TabsTrigger>
            </TabsList>
          </div>

          <div
            className="overflow-hidden transition-[height] duration-300 ease-out"
            style={contentHeight ? { height: contentHeight } : undefined}
          >
            <div ref={contentInnerRef} className="px-6 pb-4 pt-4">
              {activeTab === 'permissions' && (
                <div className="max-h-[52vh] overflow-y-auto pr-1">
                  <TunnelPermissionManager tunnelId={conn.tunnelId} />
                </div>
              )}

              {activeTab === 'audit' && (
                <div className="max-h-[52vh] overflow-y-auto pr-1">
                  <TunnelAuditTable tunnelId={conn.tunnelId} />
                </div>
              )}

              {activeTab === 'connection' && <ConnectionInfoTab connection={conn} />}
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ─── Connection Info Tab ────────────────────────────────────────────────────

function ConnectionInfoTab({ connection }: { connection: TunnelConnection }) {
  const [copied, setCopied] = React.useState(false);
  const machineInfo = connection.machineInfo as Record<string, string> | undefined;
  const isOnline = connection.isLive;
  const capabilities = connection.capabilities || [];

  const handleCopy = () => {
    navigator.clipboard.writeText(connection.tunnelId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const rows: { label: string; value: string }[] = [
    { label: 'Tunnel ID', value: connection.tunnelId },
    { label: 'Status', value: isOnline ? 'Online' : 'Offline' },
    { label: 'Hostname', value: machineInfo?.hostname || 'Unknown' },
    { label: 'Platform', value: machineInfo?.platform ? `${machineInfo.platform} ${machineInfo.arch || ''}` : 'Unknown' },
    { label: 'OS Version', value: machineInfo?.osVersion || 'Unknown' },
    { label: 'Agent Version', value: machineInfo?.agentVersion || 'Unknown' },
    { label: 'Capabilities', value: capabilities.join(', ') || 'None' },
    { label: 'Created', value: new Date(connection.createdAt).toLocaleString() },
  ];

  if (connection.lastHeartbeatAt) {
    rows.push({ label: 'Last Heartbeat', value: new Date(connection.lastHeartbeatAt).toLocaleString() });
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[120px_1fr] items-center gap-3 rounded-2xl border border-border/60 bg-card/40 px-3 py-2.5"
        >
          <span className="text-xs text-muted-foreground">{row.label}</span>
          <div className="flex items-center justify-end gap-2 min-w-0">
            {row.label === 'Status' ? (
              <Badge
                variant="outline"
                className={cn(
                  'h-6 px-2.5 gap-1.5 border',
                  isOnline
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                    : 'bg-muted text-muted-foreground border-border/70',
                )}
              >
                {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {row.value}
              </Badge>
            ) : row.label === 'Capabilities' ? (
              <div className="flex flex-wrap justify-end gap-1.5">
                {capabilities.length > 0 ? capabilities.map((cap) => (
                  <Badge key={cap} variant="secondary" className="h-6 text-[11px] font-medium">
                    {cap}
                  </Badge>
                )) : (
                  <span className="text-sm text-muted-foreground">None</span>
                )}
              </div>
            ) : (
              <span className={cn('text-sm truncate', row.label === 'Tunnel ID' ? 'font-mono' : 'font-medium')}>
                {row.value}
              </span>
            )}
            {row.label === 'Tunnel ID' && (
              <button
                onClick={handleCopy}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border/60 bg-background hover:bg-muted transition-colors cursor-pointer"
                aria-label="Copy tunnel ID"
                type="button"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
