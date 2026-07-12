'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { ProviderList } from '@/features/providers/provider-list';
import { GlobalProviderModal } from '@/features/providers/provider-modal';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { Plus } from 'lucide-react';
import { useMemo } from 'react';

export default function ProvidersPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);
  const { data: providersData, isLoading, refetch } = useOpenCodeProviders();

  const connectedProviders = useMemo(() => {
    if (!providersData) return [];
    const connectedIds = new Set(providersData.connected ?? []);
    return (providersData.all ?? []).filter((p) => connectedIds.has(p.id));
  }, [providersData]);

  return (
    <div className="container mx-auto max-w-4xl px-3 py-4 sm:px-4 sm:py-8">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold sm:text-xl">
              {tHardcodedUi.raw('componentsPagesSettingsProvidersPage.line27JsxTextLlmProviders')}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {tHardcodedUi.raw(
                'componentsPagesSettingsProvidersPage.line29JsxTextConnectModelProvidersThatPowerYourAgent',
              )}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => openProviderModal('providers')}>
            <Plus className="h-4 w-4" />
            {tHardcodedUi.raw('componentsPagesSettingsProvidersPage.line38JsxTextAddProvider')}
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
          <div className="border-border/60 flex flex-col items-center gap-4 rounded-2xl border border-dashed py-16">
            <p className="text-muted-foreground/60 text-sm">
              {tHardcodedUi.raw(
                'componentsPagesSettingsProvidersPage.line54JsxTextNoProvidersConnectedYet',
              )}
            </p>
            <Button variant="outline" size="sm" onClick={() => openProviderModal('providers')}>
              <Plus className="h-4 w-4" />
              {tHardcodedUi.raw(
                'componentsPagesSettingsProvidersPage.line61JsxTextConnectYourFirstProvider',
              )}
            </Button>
          </div>
        )}
      </div>

      <GlobalProviderModal />
    </div>
  );
}
