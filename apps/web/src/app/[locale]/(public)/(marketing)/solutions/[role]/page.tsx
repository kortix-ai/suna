import { getRole, ROLES } from '@/features/marketing/solutions/registry';
import { RolePage } from '@/features/marketing/solutions/role-page';
import { marketingMetadata } from '@/lib/seo/metadata';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * `/solutions/<role>` — one page per role, one renderer, eight content files.
 *
 * Metadata is resolved through `marketingMetadata()` exactly like every static
 * marketing route; the difference is only that the path is computed. Every role
 * therefore needs its own record in `lib/seo/public-content.ts`, which is
 * asserted by `registry.test.ts` rather than discovered at request time —
 * `marketingMetadata()` throws for a path with no record.
 *
 * `dynamicParams = false` makes an unknown role a 404 rather than a render of
 * an empty page.
 */
export const dynamicParams = false;

export function generateStaticParams(): { role: string }[] {
  return ROLES.map((role) => ({ role: role.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ role: string }>;
}): Promise<Metadata> {
  const { role } = await params;
  if (!getRole(role)) return {};
  return marketingMetadata(`/solutions/${role}`);
}

export default async function SolutionRolePage({
  params,
}: {
  params: Promise<{ role: string }>;
}): Promise<ReactNode> {
  const { role: slug } = await params;
  const role = getRole(slug);
  if (!role) notFound();
  return <RolePage role={role} />;
}
