'use client';

import { useTranslations } from '@/i18n/use-translations';
// Guided Directory Sync (SCIM) setup — the provisioning counterpart to the
// SSO wizard. Linked from the SCIM card; provider picked via ?provider=<id>.

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AccountPane } from '@/features/accounts/hub/account-pane';
import { useAuth } from '@/features/providers/auth-provider';
import { ScimSetupWizard } from '@/features/sso-setup/setup-wizard';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { useParams } from 'next/navigation';

export default function ScimSetupPage() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const params = useParams<{ id: string }>();
  const accountId = params?.id;
  const { user, isLoading: authLoading } = useAuth();

  useSignedOutRedirect();

  if (authLoading || !user || !accountId) {
    return <ConnectingScreen />;
  }

  return (
    <AccountPane
      back={{
        href: `/accounts/${accountId}?tab=identity`,
        label: tI18nComplete.raw('textafa2d8b63568'),
      }}
      width="full"
    >
      <ScimSetupWizard accountId={accountId} />
    </AccountPane>
  );
}
