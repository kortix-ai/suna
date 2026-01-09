'use client';

import { useState, useRef, useEffect, Suspense, lazy } from 'react';
import { MapPin } from 'lucide-react';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { useIsMobile, useLeadingDebouncedCallback } from '@/hooks/utils';
import { ChatInput, ChatInputHandles } from '@/components/thread/chat-input/chat-input';
import { useAuth } from '@/components/AuthProvider';
import { useRouter } from 'next/navigation';
import { useOptimisticAgentStart } from '@/hooks/threads';
import { useAgentSelection } from '@/stores/agent-selection-store';
import { useSunaModePersistence } from '@/stores/suna-modes-store';
import { useQuery } from '@tanstack/react-query';
import { agentKeys } from '@/hooks/agents/keys';
import { getAgents } from '@/hooks/agents/utils';

const SunaModesPanel = lazy(() => 
  import('@/components/dashboard/suna-modes-panel').then(mod => ({ default: mod.SunaModesPanel }))
);

// Mobile users are redirected at the edge by middleware (hyper-fast)
// This page only renders for desktop users

export default function BerlinPage() {
  const isMobile = useIsMobile();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const chatInputRef = useRef<ChatInputHandles>(null);
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const { selectedAgentId, setSelectedAgent, initializeFromAgents } = useAgentSelection();
  
  // Use centralized optimistic agent start hook
  const { startAgent, isStarting: isOptimisticStarting } = useOptimisticAgentStart('/');
  const {
    selectedMode,
    selectedCharts,
    selectedOutputFormat,
    selectedTemplate,
    setSelectedMode,
    setSelectedCharts,
    setSelectedOutputFormat,
    setSelectedTemplate,
  } = useSunaModePersistence();

  const { data: agentsResponse } = useQuery({
    queryKey: agentKeys.list({
      limit: 100,
      sort_by: 'name',
      sort_order: 'asc'
    }),
    queryFn: () => getAgents({
      limit: 100,
      sort_by: 'name',
      sort_order: 'asc'
    }),
    enabled: !!user && !isLoading,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const agents = Array.isArray(agentsResponse?.agents) ? agentsResponse.agents : [];

  useEffect(() => {
    if (agents.length > 0) {
      initializeFromAgents(agents, undefined, setSelectedAgent);
    }
  }, [agents, initializeFromAgents, setSelectedAgent]);

  const selectedAgent = selectedAgentId
    ? agents.find(agent => agent.agent_id === selectedAgentId)
    : null;
  const isSunaAgent = !user || selectedAgent?.metadata?.is_suna_default || false;

  const handleChatInputSubmit = useLeadingDebouncedCallback(async (
    message: string,
    options?: { model_name?: string; enable_thinking?: boolean }
  ) => {
    if ((!message.trim() && !chatInputRef.current?.getPendingFiles().length) || isSubmitting || isOptimisticStarting) return;
    if (!user && !isLoading) {
      router.push('/auth');
      return;
    }

    setIsSubmitting(true);
    const pendingFiles = chatInputRef.current?.getPendingFiles() || [];

    console.log('[Berlin] Starting agent with:', {
      prompt: message.substring(0, 100),
      promptLength: message.length,
      model_name: options?.model_name,
      agent_id: selectedAgentId,
      pendingFiles: pendingFiles.length,
    });

    const result = await startAgent({
      message,
      files: pendingFiles,
      modelName: options?.model_name,
      agentId: selectedAgentId || undefined,
    });

    if (!result) {
      // Error was handled by the hook, reset state
      setIsSubmitting(false);
    }
  }, 1200);

  return (
    <main className="w-full">
      <section className="w-full relative overflow-hidden">
        <div className="relative flex flex-col items-center w-full px-4 sm:px-6 pb-8 sm:pb-10">
          <AnimatedBg
            variant="hero"
            sizeMultiplier={isMobile ? 0.7 : 1}
            blurMultiplier={isMobile ? 0.6 : 1}
          />

          <div className="relative z-10 pt-20 sm:pt-24 md:pt-32 mx-auto h-full w-full max-w-6xl flex flex-col items-center justify-center min-h-[60vh] sm:min-h-0">
            <div className="flex flex-col items-center justify-center gap-3 sm:gap-4 pt-12 sm:pt-20 max-w-4xl mx-auto pb-6 sm:pb-7">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/5 border border-primary/10">
                <MapPin className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-primary">Berlin, Germany</span>
              </div>
              
              <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-medium tracking-tighter text-balance text-center px-4 sm:px-2">
                Kortix.
              </h1>
              
              <div className="text-center space-y-2 max-w-3xl px-4">
                <h2 className="text-lg sm:text-xl md:text-2xl font-medium tracking-tight text-muted-foreground">
                  Dein Autonomer KI-Worker
                </h2>
                <p className="text-sm sm:text-base text-muted-foreground/80 font-normal text-balance leading-relaxed">
                  Gebaut für komplexe Aufgaben, entwickelt für alles. Der ultimative KI-Assistent, der alles bewältigt—von einfachen Anfragen bis zu mega-komplexen Projekten.
                </p>
              </div>

              <div className="flex flex-col items-center w-full max-w-3xl mx-auto gap-2 flex-wrap justify-center px-4 sm:px-0">
                <div className="w-full relative">
                  <div className="relative z-10">
                    <ChatInput
                      ref={chatInputRef}
                      onSubmit={handleChatInputSubmit}
                      placeholder="Beschreibe deine Aufgabe..."
                      loading={isSubmitting}
                      disabled={isSubmitting}
                      value={inputValue}
                      onChange={setInputValue}
                      isLoggedIn={!!user}
                      selectedAgentId={selectedAgentId}
                      onAgentSelect={setSelectedAgent}
                      autoFocus={false}
                      enableAdvancedConfig={false}
                      selectedMode={selectedMode}
                      onModeDeselect={() => setSelectedMode(null)}
                      selectedCharts={selectedCharts}
                      selectedOutputFormat={selectedOutputFormat}
                      selectedTemplate={selectedTemplate}
                    />
                  </div>
                </div>
              </div>

              {isSunaAgent && (
                <div className="w-full max-w-3xl mx-auto mt-4 px-4 sm:px-0">
                  <Suspense fallback={<div className="h-24 animate-pulse bg-muted/10 rounded-lg" />}>
                    <SunaModesPanel
                      selectedMode={selectedMode}
                      onModeSelect={setSelectedMode}
                      onSelectPrompt={setInputValue}
                      isMobile={isMobile}
                      selectedCharts={selectedCharts}
                      onChartsChange={setSelectedCharts}
                      selectedOutputFormat={selectedOutputFormat}
                      onOutputFormatChange={setSelectedOutputFormat}
                      selectedTemplate={selectedTemplate}
                      onTemplateChange={setSelectedTemplate}
                    />
                  </Suspense>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
