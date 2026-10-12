import { redirect } from 'next/navigation';

/**
 * Kortix Capture's organization settings are the `capture` section of the
 * account settings, which open over any page (`?accountId=&accountTab=`, see
 * `stores/account-panel-store.ts`). This address opens them over Devices.
 */
export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  redirect(`/capture/${accountId}/devices?accountId=${accountId}&accountTab=capture`);
}
