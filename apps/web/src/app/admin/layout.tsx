import { cookies } from 'next/headers';

import { AdminShell } from './_components/admin-shell';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // The console keeps its OWN open/collapsed cookie so a toggle here never
  // writes the shared `sidebar_state` the project sidebar reads. Seed the
  // provider's initial value on the server so SSR matches the first client paint.
  const cookieStore = await cookies();
  const raw = cookieStore.get('admin_sidebar_state')?.value;
  const initialOpen = raw === 'false' ? false : true;

  return <AdminShell initialOpen={initialOpen}>{children}</AdminShell>;
}
