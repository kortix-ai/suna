'use client';

import { useProjectModels } from '@kortix/sdk/react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslations } from '@/i18n/use-translations';

import { parseAppReturnUrl, usableModelCount } from './app-return';

/**
 * The way back to the mobile app after it opened this page to connect a
 * model provider (`?return_to=kortix://…`, see `./app-return.ts`).
 *
 * Renders nothing without a valid `return_to`, so the web page is unchanged.
 * With one:
 * - once the project has a usable model, the page redirects to `return_to`
 *   ONE time, and the app's auth session closes itself;
 * - a bottom bar always offers the same URL as a tap. Chrome can block an
 *   app-scheme navigation that no tap started; the tap is never blocked.
 *   The bar sits in the capabilities layout's `h-svh` flex column below the
 *   `flex-1` page shell, so it takes its own height and covers no row.
 *
 * Saving a provider already refetches `/model-picker`
 * (`refreshProjectProviderState`, polls up to 45 s), so `useProjectModels`
 * turns non-empty here without a refetch of its own.
 */
export function AppReturnBar({ projectId }: { projectId: string }) {
  const t = useTranslations('modelAccess');
  const returnUrl = parseAppReturnUrl(useSearchParams().get('return_to'));
  const models = useProjectModels(returnUrl ? projectId : null);
  const connected = usableModelCount(models) > 0;
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (!returnUrl || !connected || redirectedRef.current) return;
    redirectedRef.current = true;
    window.location.assign(returnUrl);
  }, [returnUrl, connected]);

  if (!returnUrl) return null;

  return (
    <div className="bg-popover border-border shrink-0 border-t p-4">
      <Button asChild size="lg" variant={connected ? 'default' : 'secondary'} className="w-full">
        <a href={returnUrl}>{connected ? t('appReturnConnected') : t('appReturn')}</a>
      </Button>
    </div>
  );
}
