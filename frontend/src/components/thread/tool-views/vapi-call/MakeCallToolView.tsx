import React, { useState, useEffect, useRef } from 'react';
import { Phone, CheckCircle, Clock, User, Mic, Brain, Loader2, AlertTriangle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { extractMakeCallData, formatPhoneNumber, statusConfig } from './_utils';
import { getToolTitle } from '../utils';
import { useVapiCallRealtime } from '@/hooks/useVapiCallRealtime';
import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { motion, AnimatePresence } from 'framer-motion';

export function MakeCallToolView({
  name = 'make-phone-call',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const callData = extractMakeCallData(toolContent);
  const [liveTranscript, setLiveTranscript] = useState<any[]>([]);
  const [liveStatus, setLiveStatus] = useState(callData?.status || 'queued');
  const [previousTranscriptLength, setPreviousTranscriptLength] = useState(0);
  const toolTitle = getToolTitle(name);
  const transcriptEndRef = useRef<HTMLDivElement>(null);




  // Subscribe to real-time updates
  useVapiCallRealtime(callData?.call_id);

  const { data: realtimeData } = useQuery({
    queryKey: ['vapi-call', callData?.call_id],
    queryFn: async () => {
      if (!callData?.call_id) return null;
      const supabase = createClient();
      const { data, error } = await supabase
        .from('vapi_calls')
        .select('*')
        .eq('call_id', callData.call_id)
        .single();
      
      if (error) {
        console.error('[MakeCallToolView] Error fetching call:', error);
        return null;
      }
      
      console.log('[MakeCallToolView] Fetched call data:', {
        status: data?.status,
        transcriptLength: Array.isArray(data?.transcript) ? data.transcript.length : 0
      });
      return data;
    },
    enabled: !!callData?.call_id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      const isLive = status && ['queued', 'ringing', 'in-progress'].includes(status);
      return isLive ? 2000 : false;
    },
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (realtimeData) {
      console.log('[MakeCallToolView] Updating from realtime data:', {
        status: realtimeData.status,
        transcript: realtimeData.transcript
      });
      
      setLiveStatus(realtimeData.status);
      
      if (realtimeData.transcript) {
        try {
          const parsed = typeof realtimeData.transcript === 'string' 
            ? JSON.parse(realtimeData.transcript) 
            : realtimeData.transcript;
          
          const transcriptArray = Array.isArray(parsed) ? parsed : [];
          console.log('[MakeCallToolView] Setting transcript:', transcriptArray.length, 'messages');
          setLiveTranscript(transcriptArray);
        } catch (e) {
          console.error('[MakeCallToolView] Failed to parse transcript:', e);
          setLiveTranscript([]);
        }
      } else {
        console.log('[MakeCallToolView] No transcript in realtime data');
      }
    }
  }, [realtimeData]);

  useEffect(() => {
    if (transcriptEndRef.current && liveTranscript.length > previousTranscriptLength) {
      // Only scroll when new messages are added
      setPreviousTranscriptLength(liveTranscript.length);
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [liveTranscript, previousTranscriptLength]);

  if (!callData) {
    return <div className="text-sm text-muted-foreground">No call data available</div>;
  }

  const status = liveStatus;
  const statusInfo = statusConfig[status as keyof typeof statusConfig] || statusConfig.queued;
  const isActive = status === 'ringing' || status === 'in-progress' || status === 'queued';

  const MessageBubble = React.memo(({ msg, index, isNew }: { msg: any; index: number; isNew: boolean }) => (
    <motion.div
      initial={isNew ? { opacity: 0, y: 20, scale: 0.9 } : { opacity: 1, y: 0, scale: 1 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={isNew ? { 
        type: "spring",
        stiffness: 400,
        damping: 25,
      } : undefined}
      className={cn(
        "text-sm p-3 rounded-2xl relative mb-3",
        msg.role === 'assistant'
          ? "bg-accent/50 border border-border ml-4"
          : "bg-muted/80 border border-border mr-4"
      )}
    >
      <div className="font-medium text-xs text-muted-foreground mb-1 flex items-center gap-1">
        {msg.role === 'assistant' ? (
          <>
            <motion.div 
              className="w-2 h-2 rounded-full bg-primary"
              animate={isNew ? { scale: [1, 1.2, 1] } : {}}
              transition={{ repeat: isNew ? 2 : 0, duration: 0.5 }}
            />
            AI Assistant
          </>
        ) : (
          <>
            <div className="w-2 h-2 rounded-full bg-muted-foreground" />
            Caller
          </>
        )}
      </div>
      <div className="text-foreground">
        {msg.message}
      </div>
    </motion.div>
  ), (prevProps, nextProps) => {
    return prevProps.msg.message === nextProps.msg.message && 
           prevProps.msg.role === nextProps.msg.role &&
           prevProps.isNew === nextProps.isNew;
  });
  
  MessageBubble.displayName = 'MessageBubble';

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn(
              "relative p-2 rounded-xl bg-gradient-to-br from-green-500/20 to-green-600/10 border border-green-500/20",
              isActive && "animate-pulse"
            )}>
              {isActive ? (
                <Loader2 className="w-5 h-5 text-green-500 animate-spin" />
              ) : (
                <Phone className="w-5 h-5 text-green-500" />
              )}
            </div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
              {isActive && (
                <span className="flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
              )}
            </div>
          </div>
          {!isStreaming && (
            <Badge
              variant={isSuccess ? "default" : "destructive"}
            >
              {isSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              )}
              {isSuccess ? 'Call initiated successfully' : 'Failed to initiate call'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {assistantContent && (
          <div className="text-sm text-foreground">{assistantContent}</div>
        )}

        <AnimatePresence mode="wait">
          {isActive && liveTranscript.length > 0 ? (
            <motion.div
              key="live-view"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.5, type: "spring" }}
              className="space-y-6"
            >
              <motion.div 
                className="relative h-32 flex items-center justify-center overflow-hidden rounded-2xl"
                initial={{ height: 0 }}
                animate={{ height: 128 }}
                transition={{ duration: 0.5, type: "spring", stiffness: 300 }}
              >
                <motion.div
                  className="relative z-10"
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ 
                    type: "spring",
                    stiffness: 260,
                    damping: 20,
                    delay: 0.2
                  }}
                >
                  <motion.div 
                    className="w-20 h-20 rounded-full bg-destructive flex items-center justify-center"
                    animate={{ 
                      scale: [1, 1.05, 1]
                    }}
                    transition={{
                      duration: 1.5,
                      repeat: Infinity,
                      ease: "easeOut"
                    }}
                  >
                    <Mic className="w-10 h-10 text-destructive-foreground" />
                  </motion.div>
                  <motion.div
                    className="absolute -bottom-6 left-1/2 transform -translate-x-1/2"
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.5 }}
                  >
                    <span className="text-xs font-bold text-red-500 uppercase tracking-wider flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      Live
                    </span>
                  </motion.div>
                </motion.div>
              </motion.div>
              <motion.div 
                className="flex justify-center"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                <div className="text-center space-y-1">
                  <div className="text-lg font-medium text-foreground">
                    {formatPhoneNumber(callData?.phone_number)}
                  </div>
                  <Badge className={cn("text-xs", statusInfo.color)}>
                    {statusInfo.label}
                  </Badge>
                </div>
              </motion.div>
              <motion.div 
                className="h-64 overflow-y-auto rounded-lg bg-muted/50 p-3 border border-border scrollbar-thin scrollbar-thumb-muted-foreground/30 scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground/50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                style={{
                  scrollBehavior: 'smooth',
                }}
              >
                {liveTranscript.map((msg, idx) => {
                  const isNew = idx >= previousTranscriptLength;
                  return (
                    <MessageBubble 
                      key={`${msg.role}-${idx}-${msg.message.substring(0, 20)}`}
                      msg={msg} 
                      index={idx}
                      isNew={isNew}
                    />
                  );
                })}
                <div ref={transcriptEndRef} className="h-4" />
              </motion.div>
            </motion.div>
          ) : (
            <motion.div
              key="regular-view"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Phone className="h-3 w-3" />
                    Phone Number
                  </div>
                  <div className="text-sm font-medium text-foreground">
                    {formatPhoneNumber(callData?.phone_number)}
                  </div>
                </div>

                {(callData?.call_id) && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CheckCircle className="h-3 w-3" />
                      Call ID
                    </div>
                    <div className="text-xs font-mono text-foreground truncate">
                      {callData.call_id}
                    </div>
                  </div>
                )}

                {callData?.model && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Brain className="h-3 w-3" />
                      Model
                    </div>
                    <div className="text-sm text-foreground">{callData.model}</div>
                  </div>
                )}

                {callData?.voice && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Mic className="h-3 w-3" />
                      Voice
                    </div>
                    <div className="text-sm text-foreground">{callData.voice}</div>
                  </div>
                )}
              </div>

              {callData?.first_message && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">First Message</div>
                  <div className="text-sm text-foreground bg-muted/50 rounded-lg p-3 border border-border">
                    {callData.first_message}
                  </div>
                </div>
              )}
              {isActive && liveTranscript.length === 0 && (
                <div className="text-center py-8">
                  <Loader2 className="h-6 w-6 mx-auto mb-2 text-muted-foreground animate-spin" />
                  <p className="text-sm text-muted-foreground">Waiting for conversation to start...</p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {callData?.message && (
          <div className="text-xs text-muted-foreground pt-2 border-t border-border">
            {callData.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}