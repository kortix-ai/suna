import { redirect } from 'next/navigation';

export default async function NestedAdminSandboxesRedirectPage({
  params,
}: {
  params: Promise<{ rest?: string[] }>;
}) {
  const { rest } = await params;
  if (rest && rest.length > 0) {
    redirect(`/admin/instances/${rest[0]}`);
  }
  redirect('/admin/instances');
}
