'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminAccountsRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin?section=accounts');
  }, [router]);
  return null;
}
