'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { getEnv } from '@/lib/env-config';
import { useTunnelStore } from '@/stores/tunnel-store';
import { createSSEStream, type SSEStream } from '@/lib/utils/sse-stream';
import { tunnelKeys } from './use-tunnel';
import type { TunnelPermissionRequest } from './use-tunnel';

export function useTunnelRealtimeSync() {
  const queryClient = useQueryClient();
  const addPendingRequest = useTunnelStore((s) => s.addPendingRequest);
  const sseStreamRef = useRef<SSEStream | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token || cancelled) return;

      if (sseStreamRef.current) {
        sseStreamRef.current.close();
        sseStreamRef.current = null;
      }

      const url = `${getEnv().BACKEND_URL}/tunnel/permission-requests/stream`;
      const stream = createSSEStream({
        url,
        token: session.access_token,
        onError: () => {
          stream.close();
          sseStreamRef.current = null;
          if (!cancelled) {
            reconnectTimerRef.current = setTimeout(connect, 5_000);
          }
        },
      });

      stream.addEventListener('tunnel_connected', () => {
        queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
      });

      stream.addEventListener('tunnel_disconnected', () => {
        queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
      });

      stream.addEventListener('connection_replaced', () => {
        queryClient.invalidateQueries({ queryKey: tunnelKeys.connections() });
      });

      stream.addEventListener('permission_request', (data) => {
        try {
          const request = JSON.parse(data) as TunnelPermissionRequest;
          addPendingRequest(request);
        } catch {}
      });

      sseStreamRef.current = stream;
      stream.connect();
    }

    connect();

    return () => {
      cancelled = true;
      if (sseStreamRef.current) {
        sseStreamRef.current.close();
        sseStreamRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [queryClient, addPendingRequest]);
}
