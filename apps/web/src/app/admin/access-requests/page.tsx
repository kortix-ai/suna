'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminAccessRequestsRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin?section=access-requests');
  }, [router]);
  return null;
}
