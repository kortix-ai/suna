/**
 * Navigation Suspense boundary for `/accounts/[id]`.
 *
 * Mirrors the column `page.tsx` paints for its own `accountQuery.isLoading`
 * state — the back row, then the content width — so the hand-over to the real
 * page has no layout shift. The sidebar and breadcrumb bar are the layout's
 * and never enter this fallback.
 */
import { AccountPane, AccountPaneSkeleton } from '@/features/accounts/hub/account-pane';

export default function AccountDetailLoading() {
  return (
    <AccountPane back={{ href: '/accounts', label: 'Back to accounts' }}>
      <AccountPaneSkeleton withTitle />
    </AccountPane>
  );
}
