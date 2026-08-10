import { redirect } from 'next/navigation';

/** @deprecated The canonical admin fleet route is `/admin/workspaces`. */
export default function LegacyAdminProjectsPage() {
  redirect('/admin/workspaces');
}
