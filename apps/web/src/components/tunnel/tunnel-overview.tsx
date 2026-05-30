'use client';

import { useTranslations } from 'next-intl';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Cable, Plus, Monitor, Trash2, Search, X, Terminal, Copy, Check } from 'lucide-react';
import { getEnv } from '@/lib/env-config';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageSearchBar } from '@/components/ui/page-search-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { Ripple } from '@/components/ui/ripple';
import { PageHeader } from '@/components/ui/page-header';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
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
import { useTunnelConnections, useDeleteTunnelConnection, type TunnelConnection } from '@/hooks/tunnel/use-tunnel';
import { useTunnelRealtimeSync } from '@/hooks/tunnel/use-tunnel-realtime';
import { TunnelSettingsDialog } from './tunnel-settings-dialog';
import { TunnelPermissionRequestDialog } from './tunnel-permission-request-dialog';
import { toast } from '@/lib/toast';

// ─── Connection card ─────────────────────────────────────────────────────────

function ConnectionItem({
  connection,
  onClick,
  onDelete,
  index,
}: {
  connection: TunnelConnection;
  onClick: () => void;
  onDelete: () => void;
  index: number;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const isOnline = connection.isLive;
  const machineInfo = connection.machineInfo as Record<string, string> | undefined;
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <motion.div
        layout
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8, scale: 0.95 }}
        transition={{ duration: 0.3, delay: Math.min(index * 0.03, 0.6) }}
      >
        <SpotlightCard className="bg-card border border-border/50">
          <div
            onClick={onClick}
            onKeyDown={(e) => {
              // Only act when the card itself is focused — nested action buttons
              // (Delete / Manage) keep their own keyboard behaviour.
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={`Manage connection ${connection.name}`}
            className="p-4 sm:p-5 flex flex-col h-full cursor-pointer group rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="relative">
                <div className="flex items-center justify-center w-9 h-9 rounded-[10px] bg-muted border border-border/50 shrink-0">
                  <Monitor className="h-4.5 w-4.5 text-foreground" />
                </div>
                {isOnline && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500 border-2 border-background" />
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-sm font-semibold text-foreground truncate">{connection.name}</h3>
                  <Badge
                    variant={isOnline ? 'highlight' : 'secondary'}
                    className="text-xs shrink-0"
                  >
                    {isOnline ? 'Online' : 'Offline'}
                  </Badge>
                </div>
                {machineInfo?.hostname && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {machineInfo.hostname}
                    {machineInfo.platform && ` · ${machineInfo.platform} ${machineInfo.arch || ''}`}
                  </p>
                )}
              </div>
            </div>

            <div className="h-[34px] mb-3">
              <p className="text-xs text-muted-foreground/80 leading-relaxed line-clamp-2">
                {connection.lastHeartbeatAt
                  ? `Last seen ${formatRelative(connection.lastHeartbeatAt)}`
                  : 'Never connected'}
              </p>
            </div>

            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-destructive h-8 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="px-2.5 text-xs">
                Manage
              </Button>
            </div>
          </div>
        </SpotlightCard>
      </motion.div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line126JsxTextDeleteConnection')}</AlertDialogTitle>
            <AlertDialogDescription>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line128JsxTextThisWillPermanentlyDelete')}<span className="font-medium text-foreground">{connection.name}</span>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line128JsxTextAndRemoveAllItsPermissionsAndAuditLogs')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={onDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function ConnectButton() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const apiUrl = `${getEnv().BACKEND_URL}/tunnel`;
  const command = `npx @kortix/agent-tunnel connect --api-url ${apiUrl}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <Button
        variant="default"
        className="px-3 sm:px-4 gap-1.5 sm:gap-2"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-4 w-4" />
        <span className="hidden xs:inline">{tHardcodedUi.raw('componentsTunnelTunnelOverview.line169JsxTextAddConnection')}</span>
        <span className="xs:hidden">Add</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center w-9 h-9 rounded-[10px] bg-muted border border-border/50">
                <Terminal className="h-4.5 w-4.5 text-foreground" />
              </div>
              <div>
                <DialogTitle>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line181JsxTextConnectAMachine')}</DialogTitle>
                <DialogDescription>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line183JsxTextRunThisCommandOnTheMachineYouWant')}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <button
              onClick={handleCopy}
              className="group flex items-center gap-2 w-full bg-foreground/[0.04] hover:bg-foreground/[0.07] border border-foreground/[0.08] rounded-2xl px-3 py-2.5 transition-colors cursor-pointer"
            >
              <code className="text-xs font-mono text-foreground/80 flex-1 text-left break-all">
                {command}
              </code>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              )}
            </button>
            <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground/60">
              <span>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line203JsxTextText1RunTheCommand')}</span>
              <span className="text-foreground/10">|</span>
              <span>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line205JsxTextText2ApproveInBrowser')}</span>
              <span className="text-foreground/10">|</span>
              <span>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line207JsxTextText3Connected')}</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConnectGuide() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);
  const apiUrl = `${getEnv().BACKEND_URL}/tunnel`;
  const command = `npx @kortix/agent-tunnel connect --api-url ${apiUrl}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative bg-muted/20 rounded-3xl border border-dashed border-border/50 flex flex-col items-center justify-center py-16 px-4 overflow-hidden">
      <Ripple mainCircleSize={160} mainCircleOpacity={0.12} numCircles={6} />
      <div className="relative z-10 flex flex-col items-center max-w-lg">
        <div className="w-16 h-16 bg-muted border rounded-2xl flex items-center justify-center mb-4">
          <Cable className="h-7 w-7 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-2">{tHardcodedUi.raw('componentsTunnelTunnelOverview.line234JsxTextConnectYourMachine')}</h3>
        <p className="text-sm text-muted-foreground text-center leading-relaxed mb-6">{tHardcodedUi.raw('componentsTunnelTunnelOverview.line236JsxTextRunThisCommandOnAnyMachineToConnect')}</p>

        <button
          onClick={handleCopy}
          className="group flex items-center gap-3 bg-foreground/[0.04] hover:bg-foreground/[0.07] border border-foreground/[0.08] rounded-2xl px-5 py-3.5 transition-colors w-full max-w-sm"
        >
          <Terminal className="h-4 w-4 text-muted-foreground shrink-0" />
          <code className="text-sm font-mono text-foreground/80 flex-1 text-left truncate">
            {command}
          </code>
          {copied ? (
            <Check className="h-4 w-4 text-emerald-500 shrink-0" />
          ) : (
            <Copy className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          )}
        </button>

        <div className="flex items-center gap-6 mt-6 text-xs text-muted-foreground/60">
          <span>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line255JsxTextText1RunTheCommand')}</span>
          <span className="text-foreground/10">|</span>
          <span>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line257JsxTextText2ApproveInBrowser')}</span>
          <span className="text-foreground/10">|</span>
          <span>{tHardcodedUi.raw('componentsTunnelTunnelOverview.line259JsxTextText3Connected')}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Loading skeleton ────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="rounded-2xl border dark:bg-card p-4 sm:p-5">
          <div className="flex items-center gap-3 mb-3">
            <Skeleton className="h-9 w-9 rounded-[10px]" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
          <Skeleton className="h-3 w-full mb-1" />
          <Skeleton className="h-3 w-4/5 mb-3" />
          <div className="flex justify-end">
            <Skeleton className="h-8 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main overview ───────────────────────────────────────────────────────────

export function TunnelOverview() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: connections = [], isLoading } = useTunnelConnections();
  const deleteMutation = useDeleteTunnelConnection();
  useTunnelRealtimeSync();

  const [selectedTunnel, setSelectedTunnel] = useState<TunnelConnection | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const hasConnections = connections.length > 0;

  const filtered = searchQuery
    ? connections.filter((c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.machineInfo as Record<string, string>)?.hostname?.toLowerCase()?.includes(searchQuery.toLowerCase()),
      )
    : connections;

  const handleDelete = async (tunnelId: string) => {
    try {
      await deleteMutation.mutateAsync(tunnelId);
      toast.success('Tunnel deleted');
      if (selectedTunnel?.tunnelId === tunnelId) {
        setSelectedTunnel(null);
        setSettingsOpen(false);
      }
    } catch {
      toast.error('Failed to delete tunnel');
    }
  };

  const handleSelect = (conn: TunnelConnection) => {
    setSelectedTunnel(conn);
    setSettingsOpen(true);
  };

  return (
    <div className="min-h-[100dvh]">
      {/* Page header */}
      <div className="container mx-auto max-w-7xl px-3 sm:px-4 py-3 sm:py-4 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both">
        <PageHeader icon={Cable}>
          <div className="space-y-2 sm:space-y-4">
            <div className="text-2xl sm:text-3xl md:text-4xl font-semibold tracking-tight">
              <span className="text-primary">Tunnel</span>
            </div>
          </div>
        </PageHeader>
      </div>

      <div className="container mx-auto max-w-7xl px-3 sm:px-4">
        {/* Search + action bar */}
        <div className="flex items-center justify-between gap-2 sm:gap-4 pb-3 sm:pb-4 pt-2 sm:pt-3 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both delay-75">
          <PageSearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={tHardcodedUi.raw('componentsTunnelTunnelOverview.line348JsxAttrPlaceholderSearchConnections')}
            className="max-w-md"
          />
          <ConnectButton />
        </div>

        {/* Content */}
        <div className="pb-6 sm:pb-8 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both delay-150">
          {isLoading ? (
            <LoadingSkeleton />
          ) : !hasConnections ? (
            <ConnectGuide />
          ) : filtered.length === 0 && searchQuery ? (
            <div className="text-center py-12 text-muted-foreground text-sm">{tHardcodedUi.raw('componentsTunnelTunnelOverview.line362JsxTextNoConnectionsMatchingLdquo')}{searchQuery}{tHardcodedUi.raw('componentsTunnelTunnelOverview.line362JsxTextRdquo')}</div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Connections
                </span>
                <Badge variant="secondary" className="text-xs tabular-nums">
                  {filtered.length}
                </Badge>
              </div>

              <AnimatePresence mode="popLayout">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {filtered.map((conn, i) => (
                    <ConnectionItem
                      key={conn.tunnelId}
                      connection={conn}
                      onClick={() => handleSelect(conn)}
                      onDelete={() => handleDelete(conn.tunnelId)}
                      index={i}
                    />
                  ))}
                </div>
              </AnimatePresence>
            </>
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
      />

      <TunnelPermissionRequestDialog />
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelative(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}
