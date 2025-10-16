import React, { useState, useEffect, useRef } from 'react';
import { Phone, Loader2, User, PhoneCall, PhoneMissed, CheckCircle2, CheckCircle, AlertTriangle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getToolTitle } from '../utils';
import { useVapiCallRealtime } from '@/hooks/useVapiCallRealtime';
import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface MonitorCallData {
  call_id: string;
  status: string;
  phone_number?: string;
  duration_seconds?: number;
  started_at?: string;
  ended_at?: string;
  transcript?: Array<{ role: string; message: string; timestamp?: string }>;
  is_live?: boolean;
  message?: string;
}

function extractMonitorData(toolContent: string | undefined): MonitorCallData | null {
  if (!toolContent) return null;
  
  try {
    const parsed = typeof toolContent === 'string' ? JSON.parse(toolContent) : toolContent;
    
    if (!parsed || typeof parsed !== 'object') return null;
    
    let output: any = {};
    
    if ('output' in parsed && typeof parsed.output === 'object') {
      output = parsed.output;
    } else if ('tool_execution' in parsed && typeof parsed.tool_execution === 'object') {
      const result = parsed.tool_execution.result || {};
      if (typeof result.output === 'string') {
        try {
          output = JSON.parse(result.output);
        } catch {
          output = {};
        }
      } else if (typeof result.output === 'object') {
        output = result.output || {};
      }
    } else if ('content' in parsed && typeof parsed.content === 'string') {
      try {
        const innerParsed = JSON.parse(parsed.content);
        return extractMonitorData(JSON.stringify(innerParsed));
      } catch {
        return null;
      }
    }
    
    return {
      call_id: output.call_id || '',
      status: output.status || 'unknown',
      phone_number: output.phone_number,
      duration_seconds: output.duration_seconds,
      started_at: output.started_at,
      ended_at: output.ended_at,
      transcript: output.transcript || [],
      is_live: output.is_live,
      message: output.message
    };
  } catch (e) {
    console.error('Error extracting monitor data:', e);
    return null;
  }
}

const statusConfig = {
  'queued': { label: 'Queued', color: 'bg-slate-500/10 text-slate-600 dark:text-slate-400', icon: Phone },
  'ringing': { label: 'Ringing', color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400', icon: PhoneCall },
  'in-progress': { label: 'In Progress', color: 'bg-green-500/10 text-green-600 dark:text-green-400', icon: PhoneCall },
  'completed': { label: 'Completed', color: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', icon: CheckCircle2 },
  'ended': { label: 'Ended', color: 'bg-gray-500/10 text-gray-600 dark:text-gray-400', icon: Phone },
  'failed': { label: 'Failed', color: 'bg-red-500/10 text-red-600 dark:text-red-400', icon: PhoneMissed },
  'unknown': { label: 'Unknown', color: 'bg-gray-500/10 text-gray-600 dark:text-gray-400', icon: Phone }
};

export function MonitorCallToolView({
  name = 'monitor_call',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const initialData = extractMonitorData(toolContent);
  console.log('[MonitorCallToolView] Component rendered with:', {
    toolContent,
    extractedData: initialData,
    callId: initialData?.call_id,
    initialTranscript: initialData?.transcript
  });
  
  const [liveTranscript, setLiveTranscript] = useState<any[]>(initialData?.transcript || []);
  const [liveStatus, setLiveStatus] = useState(initialData?.status || 'unknown');
  const toolTitle = getToolTitle(name);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  
  // Don't use the hook, we'll implement our own subscription
  // useVapiCallRealtime(initialData?.call_id);
  
  // Set up direct Supabase real-time subscription
  useEffect(() => {
    if (!initialData?.call_id) return;
    
    console.log('[MonitorCallToolView] Setting up real-time subscription for:', initialData.call_id);
    const supabase = createClient();
    let channel: RealtimeChannel;
    
    const setupSubscription = async () => {
      // First, do an initial fetch to get current data
      const { data: currentData } = await supabase
        .from('vapi_calls')
        .select('*')
        .eq('call_id', initialData.call_id)
        .maybeSingle();
      
      if (currentData) {
        console.log('[MonitorCallToolView] Initial data from DB:', {
          status: currentData.status,
          transcriptLength: Array.isArray(currentData.transcript) ? currentData.transcript.length : 0
        });
        setLiveStatus(currentData.status);
        if (currentData.transcript) {
          const transcript = typeof currentData.transcript === 'string' 
            ? JSON.parse(currentData.transcript) 
            : currentData.transcript;
          setLiveTranscript(Array.isArray(transcript) ? transcript : []);
        }
      }
      
      // Set up real-time subscription
      channel = supabase
        .channel(`call-monitor-${initialData.call_id}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'vapi_calls',
            filter: `call_id=eq.${initialData.call_id}`
          },
          (payload) => {
            console.log('[MonitorCallToolView] Real-time update received:', payload);
            
            if (payload.new) {
              const newData = payload.new as any;
              setLiveStatus(newData.status);
              
              if (newData.transcript) {
                const transcript = typeof newData.transcript === 'string' 
                  ? JSON.parse(newData.transcript) 
                  : newData.transcript;
                const transcriptArray = Array.isArray(transcript) ? transcript : [];
                console.log('[MonitorCallToolView] Updating transcript via real-time:', transcriptArray.length, 'messages');
                setLiveTranscript(transcriptArray);
              }
            }
          }
        )
        .subscribe((status) => {
          console.log('[MonitorCallToolView] Subscription status:', status);
        });
    };
    
    setupSubscription();
    
    return () => {
      console.log('[MonitorCallToolView] Cleaning up subscription');
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [initialData?.call_id]);

  const { data: realtimeData, refetch } = useQuery({
    queryKey: ['vapi-call', initialData?.call_id],
    queryFn: async () => {
      if (!initialData?.call_id) return null;
      const supabase = createClient();
      
      // Use maybeSingle() instead of single() to handle 0 rows gracefully
      const { data, error } = await supabase
        .from('vapi_calls')
        .select('*')
        .eq('call_id', initialData.call_id)
        .maybeSingle();
      
      if (error && error.code !== 'PGRST116') {
        console.error('[MonitorCallToolView] Error fetching call data:', error);
        return null;
      }
      
      // If no data found, return initial data to keep showing something
      if (!data) {
        console.log('[MonitorCallToolView] No data found, using initial data');
        return {
          call_id: initialData.call_id,
          status: initialData.status || 'queued',
          transcript: initialData.transcript || [],
          phone_number: initialData.phone_number,
          is_live: true
        };
      }
      
      console.log('[MonitorCallToolView] Fetched call data:', {
        status: data.status,
        transcriptLength: Array.isArray(data.transcript) ? data.transcript.length : 0
      });
      return data;
    },
    enabled: !!initialData?.call_id,
    refetchInterval: (query) => {
      // Use either the fetched status or initial status
      const status = query.state.data?.status || initialData?.status || liveStatus;
      const isLive = status && ['queued', 'ringing', 'in-progress'].includes(status);
      console.log(`[MonitorCallToolView] Polling check - Status: ${status}, isLive: ${isLive}`);
      // Poll more frequently for live calls
      return isLive ? 1000 : false;  // Poll every 1 second for live calls
    },
    staleTime: 0,  // Always consider data stale to ensure fresh updates
    gcTime: 5 * 60 * 1000,  // Keep in cache for 5 minutes
  });

  // Remove this useEffect as we're now handling updates via direct subscription
  // The query is now just for backup/fallback

  useEffect(() => {
    if (transcriptEndRef.current && liveTranscript.length > 0) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveTranscript]);

  // Backup polling in case real-time subscription fails
  useEffect(() => {
    if (liveStatus === 'in-progress' || liveStatus === 'ringing' || liveStatus === 'queued') {
      console.log('[MonitorCallToolView] Setting up backup polling for active call');
      const interval = setInterval(() => {
        // Only refetch if we haven't received updates in a while
        refetch();
      }, 3000); // Less frequent since we have real-time subscription
      
      return () => clearInterval(interval);
    }
  }, [liveStatus, refetch]);

  if (!initialData) {
    return <div className="text-sm text-muted-foreground">No call monitoring data available</div>;
  }

  // Use the live state which is updated by real-time subscription
  const currentStatus = liveStatus;
  const statusInfo = statusConfig[currentStatus as keyof typeof statusConfig] || statusConfig.unknown;
  const StatusIcon = statusInfo.icon;
  const isActive = currentStatus === 'ringing' || currentStatus === 'in-progress' || currentStatus === 'queued';
  const currentTranscript = liveTranscript; // Always use the live transcript state
  
  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn(
              "relative p-2 rounded-xl bg-gradient-to-br from-indigo-500/20 to-indigo-600/10 border border-indigo-500/20",
              isActive && "animate-pulse"
            )}>
              {isActive ? (
                <Loader2 className="w-5 h-5 text-indigo-500 dark:text-indigo-400 animate-spin" />
              ) : (
                <StatusIcon className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
              )}
            </div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                Call Monitor
              </CardTitle>
              {isActive && (
                <span className="flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-red-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                </span>
              )}
            </div>
          </div>
          {!isStreaming && (
            <Badge
              variant="secondary"
              className={
                isSuccess
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
            >
              {isSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              )}
              {isSuccess ? 'Call monitoring active' : 'Failed to monitor call'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {assistantContent && (
          <div className="text-sm text-foreground">{assistantContent}</div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Call ID</div>
            <div className="text-xs font-mono text-foreground truncate">
              {initialData.call_id}
            </div>
          </div>
          
          {initialData.phone_number && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Phone Number</div>
              <div className="text-sm font-medium text-foreground">
                {initialData.phone_number}
              </div>
            </div>
          )}
        </div>

        {currentTranscript.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <User className="h-3 w-3" />
              {isActive ? (
                <span className="text-red-500 font-bold">🔴 LIVE CONVERSATION</span>
              ) : (
                <span>Conversation Transcript</span>
              )}
            </div>
            <div className="space-y-2 bg-muted/30 rounded-lg p-3 border border-border max-h-96 overflow-y-auto">
              {currentTranscript.map((msg, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "text-sm p-2 rounded transition-all",
                    msg.role === 'assistant'
                      ? "bg-primary/5 border-l-2 border-primary/20"
                      : "bg-secondary/50 border-l-2 border-secondary/20",
                    idx === currentTranscript.length - 1 && isActive && "animate-pulse"
                  )}
                >
                  <div className="font-medium text-xs text-muted-foreground mb-1">
                    {msg.role === 'assistant' ? '🤖 AI Assistant' : '👤 Caller'}
                  </div>
                  <div className="text-foreground">{msg.message}</div>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </div>
        ) : isActive ? (
          <div className="text-center py-8">
            <Loader2 className="h-6 w-6 mx-auto mb-2 text-muted-foreground animate-spin" />
            <p className="text-sm text-muted-foreground">Waiting for conversation to start...</p>
          </div>
        ) : (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No transcript available yet
          </div>
        )}

        {initialData.message && (
          <div className="text-xs text-muted-foreground pt-2 border-t border-border">
            {initialData.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
