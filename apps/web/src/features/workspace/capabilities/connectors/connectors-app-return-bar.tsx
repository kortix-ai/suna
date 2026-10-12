'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';
import {
  parseAppReturnUrl,
  resolveAppReturn,
} from '@/features/workspace/capabilities/shared/app-return-url';
import { useTranslations } from '@/i18n/use-translations';

const RETURN_TO_STORAGE_KEY = 'kortix:connectors-return-to';

/** `sessionStorage` sends no event to its own tab, so there is nothing to subscribe to. */
const subscribeToNothing = () => () => {};

function readRemembered(): string | null {
  try {
    return window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY);
  } catch {
    return null;
  }
}

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
 * The bar remembers `return_to` for the browser tab. The list, an app and a
 * connector are separate URLs, and the links between them do not carry the
 * param, so the URL alone would lose the bar on the first click. A remembered
 * value is validated again on every read, exactly like a URL one.
 */
export function ConnectorsAppReturnBar() {
  const t = useTranslations('connectorsAppReturn');
  const fromUrl = parseAppReturnUrl(useSearchParams().get('return_to'));
  // The server snapshot is `null`: storage does not exist there, and the
  // hydrating render must match the server's.
  const remembered = useSyncExternalStore(subscribeToNothing, readRemembered, () => null);
  useEffect(() => {
    if (!fromUrl) return;
    try {
      window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, fromUrl);
    } catch {
      // Storage is blocked (private mode): the bar lasts for this URL only.
    }
  }, [fromUrl]);
  const returnUrl = resolveAppReturn(fromUrl, remembered);

  if (!returnUrl) return null;

  return (
    <div className="bg-popover border-border shrink-0 border-t p-4">
      <Button asChild size="lg" className="w-full">
        <a href={returnUrl}>{t('done')}</a>
      </Button>
    </div>
  );
}
