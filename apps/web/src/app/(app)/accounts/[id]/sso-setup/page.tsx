'use client';

import { useTranslations } from '@/i18n/use-translations';
// Guided SSO setup (Vercel-style wizard). Linked from the SAML SSO card's
// Configure button; provider picked via ?provider=<id>.

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AccountPane } from '@/features/accounts/hub/account-pane';
import { useAuth } from '@/features/providers/auth-provider';
import { SsoSetupWizard } from '@/features/sso-setup/setup-wizard';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { useParams } from 'next/navigation';

export default function SsoSetupPage() {
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
      <SsoSetupWizard accountId={accountId} />
    </AccountPane>
  );
}
