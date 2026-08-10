import { permanentRedirect } from 'next/navigation';

type LegacyProjectsPageProps = {
  params: Promise<{ legacyPath?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Project URLs are a compatibility boundary only.
 *
 * Middleware performs this redirect before route rendering. This page keeps
 * the same contract when middleware is bypassed by a custom self-host setup.
 */
export default async function LegacyProjectsPage({
  params,
  searchParams,
}: LegacyProjectsPageProps) {
  const { legacyPath = [] } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }

  const suffix = legacyPath.map(encodeURIComponent).join('/');
  const destination = `/workspaces${suffix ? `/${suffix}` : ''}`;
  permanentRedirect(`${destination}${query.size > 0 ? `?${query}` : ''}`);
}
