'use client';

// Desktop overlay for src/app/(app)/projects/page.tsx.
//
// The web version calls the server-side `redirect()` from next/navigation. A
// static export prerenders that at build time, which would bake a redirect into
// the shipped HTML instead of performing one when the user actually opens
// /projects. Same destination, resolved on the client instead.

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';

export default function ProjectsIndexPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(PROJECT_LANDING_PATH);
  }, [router]);

  return null;
}
