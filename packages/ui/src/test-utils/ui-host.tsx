import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'use-intl';

import type { UiI18nHost } from '../i18n';
import { SessionIdsProvider } from '../providers/session-ids';
import { UiProvider, type UiNavigation, type UiRouter } from '../providers/ui-provider';

const i18n: UiI18nHost = { useTranslations, useLocale };
const noopRouter: UiRouter = { push() {}, replace() {}, prefetch() {}, back() {} };

/**
 * The host adapters a page gets from its host, as fixed test values: the route
 * params `{ id, sessionId }` (also the SessionIdsProvider ids), the viewer id,
 * the router and the use-intl hooks. Mount it inside `IntlTestProvider`.
 */
export function TestUiHost({
  params = {},
  viewerId,
  pathname = '/',
  searchParams = '',
  router = noopRouter,
  children,
}: {
  params?: { id?: string; sessionId?: string };
  viewerId?: string;
  pathname?: string;
  searchParams?: string;
  router?: UiRouter;
  children: ReactNode;
}) {
  const navigation: UiNavigation = {
    useRouter: () => router,
    usePathname: () => pathname,
    useSearchParams: () => new URLSearchParams(searchParams),
    useParams: () => params,
  };
  return (
    <UiProvider navigation={navigation} i18n={i18n} useViewerId={() => viewerId}>
      <SessionIdsProvider projectId={params.id} sessionId={params.sessionId}>
        {children}
      </SessionIdsProvider>
    </UiProvider>
  );
}
