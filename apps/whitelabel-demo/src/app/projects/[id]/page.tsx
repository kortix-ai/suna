'use client';

import { useWorkspace } from '@/components/workspace-access';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** A project has no page of its own in Lumen: it is a workspace. */
export default function ProjectPage() {
  const ws = useWorkspace();
  const router = useRouter();
  useEffect(() => router.replace(`/w/${ws._id}`), [router, ws._id]);
  return null;
}
