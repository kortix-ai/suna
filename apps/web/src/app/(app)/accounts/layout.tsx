'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/features/layout/app-header';
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
    <div className="bg-secondary flex min-h-screen flex-col">
      <AppHeader user={user} breadcrumb="Accounts" />
      <main className="ring-input bg-background flex-1 rounded-t-3xl px-4 py-10 shadow-[0_-8px_24px_0_rgba(0,0,0,0.04)] ring sm:py-12">
        {children}
      </main>
    </div>
  );
};

export default Layout;
