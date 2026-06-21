'use client';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/features/layout/app-header';
import { useAuth } from '@/features/providers/auth-provider';
import { useRouter } from 'next/navigation';
import React, { useEffect } from 'react';

type LayoutProps = { children: React.ReactNode };

const Layout = ({ children }: LayoutProps) => {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/auth');
  }, [isLoading, user, router]);

  if (isLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  return (
    <div className="bg-foreground/5 flex min-h-screen flex-col">
      <AppHeader user={user} breadcrumb="Accounts" />
      <main className="ring-input bg-background px-mobile flex-1 rounded-t-3xl py-10 ring sm:py-12">
        {children}
      </main>
    </div>
  );
};

export default Layout;
