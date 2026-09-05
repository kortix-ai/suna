'use client';

// Guided SSO setup (Vercel-style wizard). Linked from the SAML SSO card's
// Configure button; provider picked via ?provider=<id>.

import { useParams } from 'next/navigation';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { AccountPane } from '@/features/accounts/hub/account-pane';
import { SsoSetupWizard } from '@/features/sso-setup/setup-wizard';
import { useAuth } from '@/features/providers/auth-provider';

export default function SsoSetupPage() {
  const params = useParams<{ id: string }>();
  const accountId = params?.id;
  const { user, isLoading: authLoading } = useAuth();

  useSignedOutRedirect();

  if (authLoading || !user || !accountId) {
    return <ConnectingScreen />;
  }

  return (
    <AccountPane
      back={{ href: `/accounts/${accountId}?tab=identity`, label: 'Back to identity' }}
      width="full"
    >
      <SsoSetupWizard accountId={accountId} />
    </AccountPane>
  );
}
