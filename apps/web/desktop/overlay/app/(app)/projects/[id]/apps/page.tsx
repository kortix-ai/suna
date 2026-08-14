'use client';

// Desktop overlay for src/app/(app)/projects/[id]/apps/page.tsx.
// The web version reads `params` on the server; under static export that value
// is the `__shell__` placeholder, so the id comes from the URL instead.

import { useParams } from 'next/navigation';

import { AppsView } from '@/features/apps/apps-view';

export default function ProjectAppsPage() {
  const { id } = useParams<{ id: string }>();
  return <AppsView projectId={id} />;
}
