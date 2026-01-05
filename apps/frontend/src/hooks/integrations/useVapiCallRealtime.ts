'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';

interface VapiCall {
  id: string;
  call_id: string;
  thread_id?: string;
  status: string;
  phone_number: string;
  duration_seconds?: number;
  transcript?: any;
  started_at?: string;
  ended_at?: string;
}

export function useVapiCallRealtime(callId?: string, threadId?: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!callId && !threadId) return;

    const supabase = createClient();
    const channelName = callId ? `vapi-call-${callId}` : `vapi-calls-thread-${threadId}`;

    console.log(`[Vapi Realtime] Setting up subscription for ${channelName}`);
    
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'vapi_calls',
          filter: callId ? `call_id=eq.${callId}` : threadId ? `thread_id=eq.${threadId}` : undefined,
        },
        (payload) => {
          console.log('[Vapi Realtime] Call update received:', {
            eventType: payload.eventType,
            callId: (payload.new as VapiCall)?.call_id,
            status: (payload.new as VapiCall)?.status,
            transcriptLength: Array.isArray((payload.new as VapiCall)?.transcript) ? (payload.new as VapiCall).transcript.length : 'not array'
          });
          
          const newData = payload.new as VapiCall;
          const oldData = payload.old as VapiCall;

          if (payload.eventType === 'UPDATE' && newData) {
            if (newData.status !== oldData?.status) {
              console.log(`[Vapi Realtime] Status changed: ${oldData?.status} → ${newData.status}`);
            }

            if (newData.transcript) {
              const oldTranscriptLength = Array.isArray(oldData?.transcript) ? oldData.transcript.length : 0;
              const newTranscriptLength = Array.isArray(newData.transcript) ? newData.transcript.length : 0;
              
              if (newTranscriptLength !== oldTranscriptLength) {
                console.log(`[Vapi Realtime] Transcript updated: ${oldTranscriptLength} → ${newTranscriptLength} messages`);
              }
            }
          }

          if (payload.eventType === 'INSERT' && newData) {
            console.log('[Vapi Realtime] New call created:', newData.call_id);
          }

          if (newData) {
            console.log('[Vapi Realtime] Invalidating and refetching queries for call:', newData.call_id);
            queryClient.invalidateQueries({
              queryKey: ['vapi-call', newData.call_id],
              exact: true
            });
            
            queryClient.invalidateQueries({
              queryKey: ['vapi-call-monitor', newData.call_id],
              exact: true
            });

            if (newData.thread_id) {
              queryClient.invalidateQueries({
                queryKey: ['vapi-calls', newData.thread_id],
                exact: true
              });
            }
            
            setTimeout(() => {
              queryClient.refetchQueries({
                queryKey: ['vapi-call', newData.call_id],
                exact: true,
                type: 'active'
              });
            }, 100);
          }
        }
      )
      .subscribe();

    console.log(`[Vapi Realtime] Subscribed to ${channelName}`);

    return () => {
      console.log(`[Vapi Realtime] Unsubscribed from ${channelName}`);
      supabase.removeChannel(channel);
    };
  }, [callId, threadId, queryClient]);
}

