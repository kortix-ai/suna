'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function AdminAccessRequestsRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin?section=access-requests');
  }, [router]);
  return null;
}
