'use client';

import { useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { parseAppReturnUrl } from '@/features/workspace/capabilities/shared/app-return-url';
import { useTranslations } from '@/i18n/use-translations';

/**
 * The way back to the mobile app after its project drawer opened this page
 * (`?return_to=kortix://connectors/done`, see `../shared/app-return-url.ts`).
 *
 * Renders nothing without a valid `return_to`, so the web page is unchanged.
 * With one, a bottom "Done" bar sends the browser to `return_to`, and the
 * app's auth session closes itself on that URL.
 *
 * Unlike the Models bar, it never redirects on its own: the user may connect
 * several connectors in one trip, and only the user knows the last one. A tap
 * is also the one navigation Chrome never blocks for an app scheme.
 *
 * `return_to` survives an OAuth 2.0 connect: the authorization start builds the
 * provider's `success_redirect_uri` from the current URL, so the user comes
 * back to this page with the bar still in place.
 */
export function ConnectorsAppReturnBar() {
  const t = useTranslations('connectorsAppReturn');
  const returnUrl = parseAppReturnUrl(useSearchParams().get('return_to'));

  if (!returnUrl) return null;

  return (
    <div className="bg-popover border-border shrink-0 border-t p-4">
      <Button asChild size="lg" className="w-full">
        <a href={returnUrl}>{t('done')}</a>
      </Button>
    </div>
  );
}
