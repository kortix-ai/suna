'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Set all dynamic options to prevent prerendering
export const dynamic = 'force-dynamic';
export const dynamicParams = true;
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const runtime = 'edge';

export default function PersonalAccountPage() {
  const router = useRouter();
  
  // Use client-side navigation instead of server redirect
  useEffect(() => {
    router.replace('/dashboard/agents');
  }, [router]);
  
  // Return a minimal loading state until redirect happens
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-8 h-8 border-2 border-primary rounded-full border-t-transparent animate-spin"></div>
    </div>
  );
} 