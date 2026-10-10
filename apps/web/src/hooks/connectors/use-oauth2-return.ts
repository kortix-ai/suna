'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';

/**
 * The OAuth 2.0 return leg. The provider sends the user back to the page the
 * grant started on, with `?oauth2=connected|error`. Confirm, refetch every
 * authorization-derived query, then strip the two `oauth2*` params and leave
 * the rest of the URL as it is.
 */
export function useOauth2Return(invalidate: () => void): void {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const result = search?.get('oauth2');
  const error = search?.get('oauth2_error');

  useEffect(() => {
    if (result !== 'connected' && result !== 'error') return;
    if (result === 'connected') successToast(tI18nComplete.raw('text75586c42e862'));
    else errorToast(error || tI18nComplete.raw('texta6fac795d6d6'));
    invalidate();
    const params = new URLSearchParams(search?.toString() ?? '');
    params.delete('oauth2');
    params.delete('oauth2_error');
    const suffix = params.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  }, [error, invalidate, pathname, result, router, search, tI18nComplete]);
}
