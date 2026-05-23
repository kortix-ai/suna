'use client';

import { useTranslations } from 'next-intl';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';

import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminRole } from '@/hooks/admin/use-admin-role';

import { AdminSidebar } from './admin-sidebar';

const BREADCRUMBS: Record<string, string> = {
  '/admin': 'Overview',
  '/admin/accounts': 'Accounts',
  '/admin/analytics': 'Analytics',
  '/admin/feedback': 'Feedback',
  '/admin/notifications': 'Notifications',
  '/admin/ops': 'Operations',
  '/admin/sandbox-pool': 'Sandbox pool',
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
      <div className="min-h-svh bg-background flex items-center justify-center">
        <Skeleton className="h-24 w-72" />
      </div>
    );
  }

  if (!adminRole?.isAdmin) {
    return (
      <div className="min-h-svh bg-background flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <ShieldCheck className="h-7 w-7 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold tracking-tight">{tHardcodedUi.raw('appAdminComponentsAdminShell.line55JsxTextAdminAccessRequired')}</h1>
            <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appAdminComponentsAdminShell.line57JsxTextYourAccountDoesnAposTHaveAdminPermissions')}</p>
          </div>
          <Link
            href="/projects"
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
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border/60 bg-background/80 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
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
