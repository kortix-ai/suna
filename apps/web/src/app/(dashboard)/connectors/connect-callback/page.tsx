"use client";

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';

/**
 * OAuth callback page for integration connections.
 * Handles the redirect from the OAuth provider (Pipedream Connect).
 *
 * Expected query params:
 * - status: 'success' | 'error'
 * - app: the app slug that was connected
 * - message: error message (if status=error)
 */
export default function ConnectCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  useEffect(() => {
    const status = searchParams.get('status');
    const app = searchParams.get('app');
    const message = searchParams.get('message');

    if (status === 'success') {
      toast.success(`${app || 'Integration'} connected successfully`);
      queryClient.invalidateQueries({ queryKey: ['integration-connections'] });
    } else if (status === 'error') {
      toast.error(message || `Failed to connect ${app || 'integration'}`);
    }

    router.replace('/connectors');
  }, [searchParams, router, queryClient]);

  return <ConnectingScreen forceConnecting minimal title="Completing connection" />;
}
