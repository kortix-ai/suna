'use client';

import { WarningIcon as TriangleAlert } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';

import { ChatGptDeviceChallenge } from '@/components/projects/chatgpt-device-challenge';
import { useChatGptConnectFlow } from '@/components/projects/chatgpt-subscription-connect';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';

/**
 * Providers with a "Sign in with OpenCode" button. The API also signs in to
 * Zen (`opencode`), but the gateway picker leaves Zen's models to native
 * OpenCode (catalog-models.ts gatewayModelsAll), so a Zen login would list
 * nothing here. Zen stays on the CLI: `kortix providers login opencode`.
 */
export const CONSOLE_SIGN_IN_PROVIDER_IDS = ['opencode-go'] as const;

/**
 * "Sign in with OpenCode" under an OpenCode key field. The login is saved as
 * that provider's own key, so the field above shows it as connected and its
 * remove control signs out. Zen and Go each hold their own login.
 */
export function ConsoleSignIn({ projectId, providerId, onConnected }: {
  projectId: string;
  providerId: string;
  onConnected: (providerId: string) => void;
}) {
  const t = useTranslations('pooledSecrets');
  const common = useTranslations('common');
  const flow = useChatGptConnectFlow({
    projectId,
    provider: providerId,
    successMessage: t('opencodeConnected'),
    onConnected: () => onConnected(providerId),
  });

  return (
    <div className="space-y-2 pt-1">
      {flow.isWaiting ? (
        <div className="border-border bg-muted/30 space-y-3 rounded-md border p-3">
          {flow.challenge ? (
            <ChatGptDeviceChallenge url={flow.challenge.url} code={flow.challenge.code}
              description={t('opencodeDeviceDescription')} />
          ) : null}
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loading className="size-3.5 shrink-0" />
            {flow.challenge ? t('oauthWaiting') : t('opencodeStarting')}
          </div>
          <Button type="button" size="sm" variant="outline" onClick={flow.cancel}>{t('cancel')}</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={flow.connect}>
            {flow.error ? common('retry') : t('opencodeSignIn')}
          </Button>
          <span className="text-muted-foreground text-xs">{t('opencodeSignInDescription')}</span>
        </div>
      )}
      {flow.error && (
        <InfoBanner tone="destructive" icon={TriangleAlert} className="text-xs">{flow.error}</InfoBanner>
      )}
    </div>
  );
}
