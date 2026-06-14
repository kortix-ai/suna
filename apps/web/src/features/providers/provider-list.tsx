'use client';

import { useTranslations } from 'next-intl';

/**
 * ProviderList — shared connected-providers list used in settings dialogs
 * and provider management UIs.
 *
 * Shows each connected provider as a compact row with model count and a
 * disconnect action. Handles its own disconnect confirmation + loading state.
 */

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
import { Button } from '@/components/ui/button';
import { errorToast, successToast } from '@/components/ui/toast';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
import { opencodeKeys } from '@/hooks/opencode/use-opencode-sessions';
import { getClient } from '@/lib/opencode-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2, Plus, Unplug } from 'lucide-react';
import { useCallback, useState } from 'react';

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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
        successToast(`${PROVIDER_LABELS[providerID] || providerID} disconnected`);
        onDisconnected?.();
      } catch {
        errorToast('Failed to disconnect provider');
      } finally {
        setDisconnecting(null);
      }
    },
    [queryClient, onDisconnected],
  );

  if (connectedProviders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <p className="text-muted-foreground/60 text-xs">
          {tHardcodedUi.raw('componentsProvidersProviderList.line103JsxTextNoProvidersConnected')}
        </p>
        {showConnectButton && onConnect && (
          <Button variant="outline" size="sm" className="mt-3" onClick={onConnect}>
            <Plus className="h-3 w-3" />
            {tHardcodedUi.raw('componentsProvidersProviderList.line112JsxTextConnectAProvider')}
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
              className="border-foreground/[0.06] bg-foreground/[0.02] overflow-hidden rounded-2xl border"
            >
              <div className="flex items-center gap-3 px-3 py-2.5">
                <ProviderLogo providerID={p.id} name={p.name} size="default" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground/85 text-sm font-medium">
                      {PROVIDER_LABELS[p.id] || p.name || p.id}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-px text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      <span className="h-1 w-1 rounded-full bg-emerald-500" />
                      connected
                    </span>
                  </div>
                  <span className="text-muted-foreground/50 text-xs">
                    {modelCount} model{modelCount !== 1 ? 's' : ''}
                    {source && (
                      <>
                        {' '}
                        · <span className="capitalize">{source}</span>
                      </>
                    )}
                  </span>
                </div>
                <Button
                  onClick={() => setConfirmDisconnect(p.id)}
                  disabled={isDisc}
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground/30 hover:bg-red-500/10 hover:text-red-500"
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
                <div className="border-border/20 border-t">
                  {Object.values(p.models ?? {}).map((m: any) => (
                    <div
                      key={m.id}
                      className="text-foreground/50 hover:bg-muted/20 flex items-center gap-2 px-3 py-1 text-xs"
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
            <AlertDialogTitle>
              {tHardcodedUi.raw('componentsProvidersProviderList.line205JsxTextDisconnectProvider')}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {confirmDisconnect && (
                <>
                  Remove{' '}
                  <span className="text-foreground font-medium">
                    {PROVIDER_LABELS[confirmDisconnect] || confirmDisconnect}
                  </span>
                  {tHardcodedUi.raw(
                    'componentsProvidersProviderList.line213JsxTextYouAposLlNeedToReEnterYour',
                  )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDisconnect && doDisconnect(confirmDisconnect)}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
