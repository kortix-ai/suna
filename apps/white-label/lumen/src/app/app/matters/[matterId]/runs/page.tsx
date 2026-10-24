import { redirect } from 'next/navigation';

/** The runs list became the matter's History. */
export default async function RunsPage({ params }: { params: Promise<{ matterId: string }> }) {
  redirect(`/app/matters/${(await params).matterId}/history`);
}
