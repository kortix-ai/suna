'use client';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { AppHeader } from '@/features/layout/app-header';
import { useAuth } from '@/features/providers/auth-provider';
import React from 'react';

type LayoutProps = { children: React.ReactNode };

const Layout = ({ children }: LayoutProps) => {
  const { user, isLoading } = useAuth();

  useSignedOutRedirect();

  if (isLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <div className="w-full border-b">
        <AppHeader user={user} breadcrumb="Accounts" />
      </div>
      <main className="bg-background px-mobile flex-1 py-10 sm:py-12">{children}</main>
    </div>
  );
};

export default Layout;
