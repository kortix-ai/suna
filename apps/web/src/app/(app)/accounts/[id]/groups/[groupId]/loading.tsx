import { useTranslations } from '@/i18n/use-translations';
/**
 * Navigation Suspense boundary for `/accounts/[id]/groups/[groupId]`.
 *
 * The route itself only forwards to `?tab=groups&group=<id>`, so this is on
 * screen for one navigation. It paints the same column the hub paints while
 * loading, so the forward lands without a layout shift.
 */
import { AccountPane, AccountPaneSkeleton } from '@/features/accounts/hub/account-pane';

export default function GroupDetailLoading() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <AccountPane back={{ href: '/accounts', label: tI18nComplete.raw('text68d8e728a8ad') }}>
      <AccountPaneSkeleton withTitle />
    </AccountPane>
  );
}
