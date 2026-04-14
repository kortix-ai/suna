'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminSandboxesRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/instances');
  }, [router]);
  return null;
}
