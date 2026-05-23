'use client';

/**
 * ProviderList — shared connected-providers list used in settings dialogs
 * and provider management UIs.
 *
 * Shows each connected provider as a compact row with model count and a
 * disconnect action. Handles its own disconnect confirmation + loading state.
 */

import { useState, useCallback } from 'react';
import { Loader2, Unplug, ChevronDown, ChevronRight, Plus, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ProviderLogo, PROVIDER_LABELS } from '@/components/providers/provider-branding';
import { getClient } from '@/lib/opencode-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { opencodeKeys } from '@/hooks/opencode/use-opencode-sessions';
import { toast } from '@/lib/toast';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';

type Provider = NonNullable<ProviderListResponse['all']>[number];

interface ProviderListProps {
  /** All connected provider objects */
  connectedProviders: Provider[];
  /** Called when user clicks "Connect" / add provider button */
  onConnect?: () => void;
  /** Called after a provider is disconnected */
  onDisconnected?: () => void;
  /** Whether to show the Connect button in the header */
  showConnectButton?: boolean;
  /** Compact mode — used in setup wizard */
  compact?: boolean;
  /** Called when user clicks on a provider row */
  onProviderClick?: (provider: Provider) => void;
}

export function ProviderList({
  connectedProviders,
  onConnect,
  onDisconnected,
  showConnectButton = true,
  compact = false,
}: ProviderListProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);

  const doDisconnect = useCallback(
    async (providerID: string) => {
      setDisconnecting(providerID);
      setConfirmDisconnect(null);
      try {
        const client = getClient();
        try {
          await client.auth.remove({ providerID });
        } catch (err) {
          const isEndpointMissing =
            err instanceof Error &&
            (err.message.includes('404') ||
              err.message.includes('405') ||
              err.message.includes('Not Found') ||
              err.message.includes('Method Not Allowed'));
          if (isEndpointMissing) {
            await client.auth.set({ providerID, auth: { type: 'api', key: '' } });
          } else {
            throw err;
          }
        }
        await client.global.dispose();
        await queryClient.refetchQueries({ queryKey: opencodeKeys.providers() });
        toast.success(`${PROVIDER_LABELS[providerID] || providerID} disconnected`);
        onDisconnected?.();
      } catch {
        toast.error('Failed to disconnect provider');
      } finally {
        setDisconnecting(null);
      }
    },
    [queryClient, onDisconnected],
  );

  if (connectedProviders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <p className="text-xs text-muted-foreground/60">No providers connected</p>
        {showConnectButton && onConnect && (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={onConnect}
          >
            <Plus className="h-3 w-3" />
            Connect a provider
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className={compact ? 'flex flex-col gap-1.5' : 'space-y-2'}>
        {connectedProviders.map((p) => {
          const modelCount = Object.keys(p.models ?? {}).length;
          const isExp = expanded === p.id;
          const isDisc = disconnecting === p.id;
          const source = (p as { source?: string }).source;

          return (
            <div
              key={p.id}
              className="rounded-2xl border border-foreground/[0.06] bg-foreground/[0.02] overflow-hidden"
            >
              <div className="flex items-center gap-3 px-3 py-2.5">
                <ProviderLogo providerID={p.id} name={p.name} size="default" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground/85">
                      {PROVIDER_LABELS[p.id] || p.name || p.id}
                    </span>
                    <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      <span className="w-1 h-1 rounded-full bg-emerald-500" />
                      connected
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground/50">
                    {modelCount} model{modelCount !== 1 ? 's' : ''}
                    {source && <> · <span className="capitalize">{source}</span></>}
                  </span>
                </div>
                <Button
                  onClick={() => setConfirmDisconnect(p.id)}
                  disabled={isDisc}
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground/30 hover:text-red-500 hover:bg-red-500/10"
                  title="Disconnect"
                >
                  {isDisc ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Unplug className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>

              {!compact && modelCount > 0 && (
                <Button
                  onClick={() => setExpanded(isExp ? null : p.id)}
                  variant="muted"
                  size="xs"
                  className="mx-3 mb-2"
                >
                  {isExp ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  {isExp ? 'Hide models' : 'Show models'}
                </Button>
              )}

              {isExp && (
                <div className="border-t border-border/20">
                  {Object.values(p.models ?? {}).map((m: any) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-2 px-3 py-1 text-xs text-foreground/50 hover:bg-muted/20"
                    >
                      <span className="truncate">{m.name || m.id}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <AlertDialog
        open={!!confirmDisconnect}
        onOpenChange={(open) => !open && setConfirmDisconnect(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect provider?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {confirmDisconnect && (
                <>
                  Remove{' '}
                  <span className="font-medium text-foreground">
                    {PROVIDER_LABELS[confirmDisconnect] || confirmDisconnect}
                  </span>
                  ? You&apos;ll need to re-enter your API key to use it again.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDisconnect && doDisconnect(confirmDisconnect)}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
