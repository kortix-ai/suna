import { cookies } from 'next/headers';

import DashboardLayoutContent from '@/components/dashboard/layout-content';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default async function DashboardLayout({
  children,
}: DashboardLayoutProps) {
  // Read the persisted sidebar state on the server so SSR matches the
  // client and we don't render expanded-then-collapse on reload.
  // SidebarProvider writes `sidebar_state=true|false` when the user toggles.
  const cookieStore = await cookies();
  const raw = cookieStore.get('sidebar_state')?.value;
  const initialSidebarOpen =
    raw === 'true' ? true : raw === 'false' ? false : undefined;

  return (
    <DashboardLayoutContent initialSidebarOpen={initialSidebarOpen}>
      {children}
    </DashboardLayoutContent>
  );
}
