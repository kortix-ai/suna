/**
 * Navigation Suspense boundary for `/accounts/[id]/groups/[groupId]`.
 *
 * The route itself only forwards to `?tab=groups&group=<id>`, so this is on
 * screen for one navigation. It paints the same column the hub paints while
 * loading, so the forward lands without a layout shift.
 */
import { AccountPane, AccountPaneSkeleton } from '@/features/accounts/hub/account-pane';

export default function GroupDetailLoading() {
  return (
    <AccountPane back={{ href: '/accounts', label: 'Back to accounts' }}>
      <AccountPaneSkeleton withTitle />
    </AccountPane>
  );
}
