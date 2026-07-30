'use client';

import { useTranslations } from 'next-intl';

import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminRole } from '@/hooks/admin/use-admin-role';

import { AdminSidebar } from './admin-sidebar';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';

const BREADCRUMBS: Record<string, string> = {
  '/admin': 'Overview',
  '/admin/accounts': 'Accounts',
  '/admin/analytics': 'Analytics',
  '/admin/feedback': 'Feedback',
  '/admin/notifications': 'Notifications',
  '/admin/ops': 'Operations',
  '/admin/providers': 'Providers',
  '/admin/stress-test': 'Stress test',
  '/admin/utils': 'Maintenance',
};

export function AdminShell({
  children,
  initialOpen,
}: {
  children: React.ReactNode;
  initialOpen: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: adminRole, isLoading } = useAdminRole();
  const pathname = usePathname();
  const label =
    BREADCRUMBS[pathname ?? ''] ??
    (pathname?.startsWith('/admin/') ? pathname.replace('/admin/', '') : 'Admin');

  if (isLoading) {
    return (
      <div className="bg-background flex min-h-svh items-center justify-center">
        <Skeleton className="h-24 w-72" />
      </div>
    );
  }

  if (!adminRole?.isAdmin) {
    return (
      <div className="bg-background flex min-h-svh items-center justify-center p-6">
        <div className="max-w-md space-y-4 text-center">
          <div className="bg-muted mx-auto flex h-14 w-14 items-center justify-center rounded-full">
            <ShieldCheck className="text-muted-foreground h-7 w-7" />
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold tracking-tight">
              {tHardcodedUi.raw('appAdminComponentsAdminShell.line55JsxTextAdminAccessRequired')}
            </h1>
            <p className="text-muted-foreground text-sm">
              {tHardcodedUi.raw(
                'appAdminComponentsAdminShell.line57JsxTextYourAccountDoesnAposTHaveAdminPermissions',
              )}
            </p>
          </div>
          <Link
            href={PROJECT_LANDING_PATH}
            className="inline-flex text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >{tHardcodedUi.raw('appAdminComponentsAdminShell.line65JsxTextBackToProjects')}</Link>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider defaultOpen={initialOpen}>
      <AdminSidebar />
      <SidebarInset className="bg-background">
        <header className="border-border/60 bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mx-1 h-4" />
          <div className="flex items-center gap-2 text-sm">
            <Link
              href="/admin"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Admin
            </Link>
            {pathname !== '/admin' && (
              <>
                <span className="text-muted-foreground/40">/</span>
                <span className="font-medium capitalize">{label}</span>
              </>
            )}
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
