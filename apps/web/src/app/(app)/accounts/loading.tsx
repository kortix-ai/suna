/**
 * Navigation Suspense boundary for `/accounts`.
 *
 * The settings shell (sidebar + breadcrumb bar) comes from `layout.tsx` and
 * stays mounted; only the content column is in flight here, so the fallback
 * is that column's own shape rather than a full-screen splash.
 */
import { AccountPane, AccountPaneSkeleton } from '@/features/accounts/hub/account-pane';

export default function AccountsLoading() {
  return (
    <AccountPane>
      <AccountPaneSkeleton withTitle />
    </AccountPane>
  );
}
