'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /setup — redirects to the workspace picker. Setup is now an overlay
 * inside the dashboard layout (SetupOverlay) and is reached AFTER the user
 * picks a workspace. This page exists so the installer's auto-open URL
 * still works.
 */
export default function SetupPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/instances');
  }, [router]);

  return null;
}
