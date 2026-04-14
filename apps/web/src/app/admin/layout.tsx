import { cookies } from 'next/headers';

import { AdminShell } from './_components/admin-shell';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // SidebarProvider owns its own cookie (`sidebar_state`) — just seed its
  // initial value on the server so SSR matches the first client paint.
  const cookieStore = await cookies();
  const raw = cookieStore.get('sidebar_state')?.value;
  const initialOpen = raw === 'true' ? true : raw === 'false' ? false : true;

  return <AdminShell initialOpen={initialOpen}>{children}</AdminShell>;
}
