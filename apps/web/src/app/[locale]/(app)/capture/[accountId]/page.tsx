import { redirect } from 'next/navigation';

/** Devices is Capture's home: `/capture/[accountId]` opens it. */
export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const p = await params;
  redirect(`/capture/${p.accountId}/devices`);
}
