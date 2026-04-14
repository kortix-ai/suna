'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminInstanceRedirectPage({
  params,
}: {
  params: Promise<{ sandboxId: string }>;
}) {
  const { sandboxId } = use(params);
  const router = useRouter();
  useEffect(() => {
    router.replace(`/instances/${sandboxId}`);
  }, [router, sandboxId]);
  return null;
}
