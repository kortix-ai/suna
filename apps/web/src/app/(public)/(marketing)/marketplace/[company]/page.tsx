import { redirect } from 'next/navigation';

// The per-source browse view was unified into the single `/marketplace` page,
// where source is a left-rail filter (`?source=<slug>`). This route now just
// forwards old/deep links there so nothing 404s.
export default async function MarketplaceCompanyPage({
  params,
}: {
  params: Promise<{ company: string }>;
}) {
  const { company } = await params;
  redirect(`/marketplace?source=${encodeURIComponent(company)}`);
}
