import { permanentRedirect } from 'next/navigation';

// The per-source browse view was unified into the single `/marketplace` page,
// where source is a left-rail filter (`?source=<slug>`). This route now just
// forwards old/deep links there so nothing 404s. Permanent (308) so search
// engines transfer the old URLs' equity instead of keeping a temporary 307.
export default async function MarketplaceCompanyPage({
  params,
}: {
  params: Promise<{ company: string }>;
}) {
  const { company } = await params;
  permanentRedirect(`/marketplace?source=${encodeURIComponent(company)}`);
}
