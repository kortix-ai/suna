'use client';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AccountSettingsShell } from '@/features/accounts/hub/account-settings-shell';
import { useAuth } from '@/features/providers/auth-provider';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import React from 'react';

type LayoutProps = { children: React.ReactNode };

/**
 * Every `/accounts/**` route renders inside the settings shell — sidebar on
 * the left, breadcrumb bar and content on the right. The auth gate sits here
 * so no child route paints its frame for a signed-out visitor.
 */
const Layout = ({ children }: LayoutProps) => {
  const { user, isLoading } = useAuth();

  useSignedOutRedirect();

  if (isLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  return <AccountSettingsShell>{children}</AccountSettingsShell>;
};

export default Layout;
