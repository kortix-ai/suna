'use client';

import React, { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProviderList } from '@/components/providers/provider-list';
import { GlobalProviderModal } from '@/components/providers/provider-modal';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { KortixLoader } from '@/components/ui/kortix-loader';

export default function ProvidersPage() {
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);
  const { data: providersData, isLoading, refetch } = useOpenCodeProviders();

  const connectedProviders = useMemo(() => {
    if (!providersData) return [];
    const connectedIds = new Set(providersData.connected ?? []);
    return (providersData.all ?? []).filter((p) => connectedIds.has(p.id));
  }, [providersData]);

  return (
    <div className="container mx-auto max-w-4xl px-3 sm:px-4 py-4 sm:py-8">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg sm:text-xl font-semibold">LLM Providers</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Connect model providers that power your agent.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openProviderModal('providers')}
          >
            <Plus className="h-4 w-4" />
            Add Provider
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <KortixLoader size="small" />
          </div>
        ) : connectedProviders.length > 0 ? (
          <ProviderList
            connectedProviders={connectedProviders}
            onDisconnected={() => refetch()}
            showConnectButton={false}
          />
        ) : (
          <div className="rounded-2xl border border-dashed border-border/60 py-16 flex flex-col items-center gap-4">
            <p className="text-sm text-muted-foreground/60">No providers connected yet</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openProviderModal('providers')}
            >
              <Plus className="h-4 w-4" />
              Connect your first provider
            </Button>
          </div>
        )}
      </div>

      <GlobalProviderModal />
    </div>
  );
}
