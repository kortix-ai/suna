import { redirect } from 'next/navigation';

import { channelsHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';

/**
 * `/projects/[id]/channels` — retired, and kept only to forward.
 *
 * Channels was a top-level Customize tab for exactly as long as it took to see
 * that it is the inbound half of Connectors, not a peer of it. It is a scope of
 * `/projects/[id]/connectors` now (`?scope=channels`), and this route exists so
 * that every bookmark, every link in a Slack thread, and every legacy nav id
 * taken while it WAS a tab still lands on the surface it named.
 *
 * A server redirect rather than the `router.replace`-in-an-effect that
 * `customize/[section]/page.tsx` uses: that page has to resolve its target
 * against per-project data first, this one does not, and doing it on the server
 * means the browser never paints the `(capabilities)` shell twice.
 *
 * Deleting the folder outright was the alternative and is the wrong one — a URL
 * that worked this morning would 404 this afternoon, silently, for anyone who
 * had saved it.
 */
export default async function RetiredProjectChannelsRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(channelsHref(id));
}
