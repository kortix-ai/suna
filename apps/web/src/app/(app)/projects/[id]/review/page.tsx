'use client';

import { useParams } from 'next/navigation';

import { ReviewView } from '@/features/workspace/customize/sections/view/review-view';

/** The Review Center is an inbox — work, not configuration. */
export default function ProjectReviewPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  if (!projectId) return null;
  return <ReviewView projectId={projectId} />;
}
