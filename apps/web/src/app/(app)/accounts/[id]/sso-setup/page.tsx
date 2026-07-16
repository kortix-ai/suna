'use client';

// Guided SSO setup (Vercel-style wizard). Linked from the SAML SSO card's
// Configure button; provider picked via ?provider=<id>.

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { SsoSetupWizard } from '@/features/sso-setup/setup-wizard';
import { useAuth } from '@/features/providers/auth-provider';

export default function SsoSetupPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const accountId = params?.id;
  const { user, isLoading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  if (authLoading || !user || !accountId) {
    return <ConnectingScreen />;
  }

  return (
    <div className="px-6 py-10">
      <SsoSetupWizard accountId={accountId} />
    </div>
  );
}
