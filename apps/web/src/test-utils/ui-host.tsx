import { UiProvider, type UiNavigation, type UiRouter } from '@kortix/ui';
import type { UiI18nHost } from '@kortix/ui/i18n';
import { SessionIdsProvider } from '@kortix/ui/providers/session-ids';
import type { ReactNode } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';

const i18n: UiI18nHost = { useTranslations, useLocale };
const noopRouter: UiRouter = { push() {}, replace() {}, prefetch() {}, back() {} };

/**
 * The host adapters KortixUiProvider gives a page, as fixed test values: the
 * route params `{ id, sessionId }` (also the SessionIdsProvider ids), the
 * viewer id, the router and the web translation hooks. Session components read
 * these from @kortix/ui, so a test that mocks `next/navigation` or `useAuth`
 * reaches nothing without this wrapper. packages/ui/src/test-utils/ui-host.tsx
 * is the package's own variant (use-intl hooks); @kortix/ui does not publish it.
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
