'use client';

// Guided Directory Sync (SCIM) setup — the provisioning counterpart to the
// SSO wizard. Linked from the SCIM card; provider picked via ?provider=<id>.

import { useParams } from 'next/navigation';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { ScimSetupWizard } from '@/features/sso-setup/setup-wizard';
import { useAuth } from '@/features/providers/auth-provider';

export default function ScimSetupPage() {
  const params = useParams<{ id: string }>();
  const accountId = params?.id;
  const { user, isLoading: authLoading } = useAuth();

  useSignedOutRedirect();

  if (authLoading || !user || !accountId) {
    return <ConnectingScreen />;
  }

  return (
    <div className="px-6 py-10">
      <ScimSetupWizard accountId={accountId} />
    </div>
  );
}
