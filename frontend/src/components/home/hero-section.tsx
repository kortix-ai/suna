'use client';
import { siteConfig } from '@/lib/site-config';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { useIsMobile } from '@/hooks/utils';
import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { AgentRunLimitError, BillingError, ProjectLimitError, ThreadLimitError } from '@/lib/api/errors';
import { optimisticAgentStart } from '@/lib/api/agents';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogOverlay,
} from '@/components/ui/dialog';
import { isLocalMode } from '@/lib/config';
import { toast } from 'sonner';
import { ChatInput, ChatInputHandles } from '@/components/thread/chat-input/chat-input';
import { normalizeFilenameToNFC } from '@/lib/utils/unicode';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { agentKeys } from '@/hooks/agents/keys';
import { getAgents } from '@/hooks/agents/utils';
import { useSunaModePersistence } from '@/stores/suna-modes-store';
import { useAgentSelection } from '@/stores/agent-selection-store';
import { useTranslations } from 'next-intl';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { DynamicGreeting } from '@/components/ui/dynamic-greeting';

const GoogleSignIn = lazy(() => import('@/components/GoogleSignIn'));
const AgentRunLimitDialog = lazy(() => 
    import('@/components/thread/agent-run-limit-dialog').then(mod => ({ default: mod.AgentRunLimitDialog }))
);
const SunaModesPanel = lazy(() => 
    import('@/components/dashboard/suna-modes-panel').then(mod => ({ default: mod.SunaModesPanel }))
);

const BlurredDialogOverlay = () => (
    <DialogOverlay className="bg-background/40 backdrop-blur-md" />
);

const PENDING_PROMPT_KEY = 'pendingAgentPrompt';

export function HeroSection() {
    const t = useTranslations('suna');
    const tBilling = useTranslations('billing');
    const { hero } = siteConfig;
    const isMobile = useIsMobile();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const [memoryEnabled, setMemoryEnabled] = useState(true);

    const {
        selectedAgentId,
        setSelectedAgent,
        initializeFromAgents,
        getCurrentAgent
    } = useAgentSelection();

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
    const router = useRouter();
    const { user, isLoading } = useAuth();
    const pricingModalStore = usePricingModalStore();
    const queryClient = useQueryClient();
    const chatInputRef = useRef<ChatInputHandles>(null);
    const [showAgentLimitDialog, setShowAgentLimitDialog] = useState(false);
    const [agentLimitData, setAgentLimitData] = useState<{
        runningCount: number;
        runningThreadIds: string[];
    } | null>(null);

    const prefetchedRouteRef = useRef<string | null>(null);
    const prefetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const { data: agentsResponse, isLoading: isLoadingAgents } = useQuery({
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

    const agents = agentsResponse?.agents || [];
    const sunaAgent = agents.find(agent => agent.metadata?.is_suna_default === true);

    useEffect(() => {
        if (agents.length > 0) {
            initializeFromAgents(agents, undefined, setSelectedAgent);
        }
    }, [agents, initializeFromAgents, setSelectedAgent]);

    const selectedAgent = selectedAgentId
        ? agents.find(agent => agent.agent_id === selectedAgentId)
        : null;
    
    // Show Kortix modes: while loading, when not logged in, or when Kortix agent is selected
    const isSunaAgent = !user || isLoading || isLoadingAgents
        ? true
        : (selectedAgent?.metadata?.is_suna_default || (!selectedAgentId && sunaAgent !== undefined) || false);

    const [authDialogOpen, setAuthDialogOpen] = useState(false);


    useEffect(() => {
        if (authDialogOpen && user && !isLoading) {
            setAuthDialogOpen(false);
            router.push('/dashboard');
        }
    }, [user, isLoading, authDialogOpen, router]);

    useEffect(() => {
        const dummyProjectId = 'prefetch-project';
        const dummyThreadId = 'prefetch-thread';
        const routeToPrefetch = `/projects/${dummyProjectId}/thread/${dummyThreadId}`;
        router.prefetch(routeToPrefetch);
        prefetchedRouteRef.current = routeToPrefetch;
    }, [router]);


    useEffect(() => {
        if (inputValue.trim() && !isSubmitting) {
            if (prefetchTimeoutRef.current) {
                clearTimeout(prefetchTimeoutRef.current);
            }

            prefetchTimeoutRef.current = setTimeout(() => {
                const dummyProjectId = 'prefetch-project';
                const dummyThreadId = 'prefetch-thread';
                const routeToPrefetch = `/projects/${dummyProjectId}/thread/${dummyThreadId}`;
                
                if (prefetchedRouteRef.current !== routeToPrefetch) {
                    router.prefetch(routeToPrefetch);
                    prefetchedRouteRef.current = routeToPrefetch;
                }
            }, 300);
        }

        return () => {
            if (prefetchTimeoutRef.current) {
                clearTimeout(prefetchTimeoutRef.current);
            }
        };
    }, [inputValue, isSubmitting, router]);

    const handleChatInputSubmit = async (
        message: string,
        options?: { model_name?: string; enable_thinking?: boolean }
    ) => {
        if ((!message.trim() && !chatInputRef.current?.getPendingFiles().length) || isSubmitting) return;
        if (!user && !isLoading) {
            localStorage.setItem(PENDING_PROMPT_KEY, message.trim());
            setAuthDialogOpen(true);
            return;
        }

        setIsSubmitting(true);
        try {
            const files = chatInputRef.current?.getPendingFiles() || [];
            localStorage.removeItem(PENDING_PROMPT_KEY);
            
            const normalizedFiles = files.map((file) => {
                const normalizedName = normalizeFilenameToNFC(file.name);
                return new File([file], normalizedName, { type: file.type });
            });
            
            const threadId = crypto.randomUUID();
            const projectId = crypto.randomUUID();
            const trimmedMessage = message.trim();
            
            chatInputRef.current?.clearPendingFiles();
            setInputValue('');
            
            sessionStorage.setItem('optimistic_prompt', trimmedMessage);
            sessionStorage.setItem('optimistic_thread', threadId);
            
            router.push(`/projects/${projectId}/thread/${threadId}?new=true`);
            
            optimisticAgentStart({
                thread_id: threadId,
                project_id: projectId,
                prompt: trimmedMessage,
                files: normalizedFiles.length > 0 ? normalizedFiles : undefined,
                model_name: options?.model_name,
                agent_id: selectedAgentId || undefined,
                memory_enabled: true,
            }).then(() => {
                queryClient.invalidateQueries({ queryKey: ['threads', 'list'] });
                queryClient.invalidateQueries({ queryKey: ['active-agent-runs'] });
            }).catch((error) => {
                console.error('Background agent start failed:', error);
                
                if (error instanceof BillingError || error?.status === 402) {
                    const errorMessage = error.detail?.message?.toLowerCase() || error.message?.toLowerCase() || '';
                    const originalMessage = error.detail?.message || error.message || '';
                    const isCreditsExhausted = 
                        errorMessage.includes('credit') ||
                        errorMessage.includes('balance') ||
                        errorMessage.includes('insufficient') ||
                        errorMessage.includes('out of credits') ||
                        errorMessage.includes('no credits');
                    
                    const balanceMatch = originalMessage.match(/balance is (-?\d+)\s*credits/i);
                    const balance = balanceMatch ? balanceMatch[1] : null;
                    
                    const alertTitle = isCreditsExhausted 
                        ? 'You ran out of credits'
                        : 'Pick the plan that works for you';
                    
                    const alertSubtitle = balance 
                        ? `Your current balance is ${balance} credits. Upgrade your plan to continue.`
                        : isCreditsExhausted 
                            ? 'Upgrade your plan to get more credits and continue using the AI assistant.'
                            : undefined;
                    
                    router.replace('/');
                    pricingModalStore.openPricingModal({ 
                        isAlert: true,
                        alertTitle,
                        alertSubtitle
                    });
                    return;
                }
                
                if (error instanceof AgentRunLimitError) {
                    const { running_thread_ids, running_count } = error.detail;
                    router.replace('/');
                    setAgentLimitData({
                        runningCount: running_count,
                        runningThreadIds: running_thread_ids,
                    });
                    setShowAgentLimitDialog(true);
                    return;
                }
                
                if (error instanceof ProjectLimitError) {
                    router.replace('/');
                    pricingModalStore.openPricingModal({ 
                        isAlert: true,
                        alertTitle: `${tBilling('reachedLimit')} ${tBilling('projectLimit', { current: error.detail.current_count, limit: error.detail.limit })}` 
                    });
                    return;
                }
                
                if (error instanceof ThreadLimitError) {
                    router.replace('/');
                    pricingModalStore.openPricingModal({ 
                        isAlert: true,
                        alertTitle: `${tBilling('reachedLimit')} ${tBilling('threadLimit', { current: error.detail.current_count, limit: error.detail.limit })}` 
                    });
                    return;
                }
                
                toast.error('Failed to start conversation');
            });
        } catch (error: any) {
            const isConnectionError =
                error instanceof TypeError &&
                error.message.includes('Failed to fetch');
            if (!isLocalMode() || isConnectionError) {
                toast.error(
                    error.message || 'Failed to create Worker. Please try again.',
                );
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <section id="hero" className="w-full relative overflow-hidden">
            <div className="relative flex flex-col items-center w-full px-4 sm:px-6 pb-8 sm:pb-10">
                <AnimatedBg
                    variant="hero"
                    sizeMultiplier={isMobile ? 0.7 : 1}
                    blurMultiplier={isMobile ? 0.6 : 1}
                    customArcs={isMobile ? {
                        left: [
                            {
                                pos: { left: -150, top: 30 },
                                size: 380,
                                tone: 'medium' as const,
                                opacity: 0.15,
                                delay: 0.5,
                                x: [0, 15, -8, 0],
                                y: [0, 12, -6, 0],
                                scale: [0.82, 1.08, 0.94, 0.82],
                                blur: ['12px', '20px', '16px', '12px'],
                            },
                        ],
                        right: [
                            {
                                pos: { right: -120, top: 140 },
                                size: 300,
                                tone: 'dark' as const,
                                opacity: 0.2,
                                delay: 1.0,
                                x: [0, -18, 10, 0],
                                y: [0, 14, -8, 0],
                                scale: [0.86, 1.14, 1.0, 0.86],
                                blur: ['10px', '6px', '8px', '10px'],
                            },
                        ],
                    } : undefined}
                />

                <div className="relative z-10 pt-20 sm:pt-24 md:pt-32 mx-auto h-full w-full max-w-6xl flex flex-col items-center justify-center min-h-[60vh] sm:min-h-0">

                    <div className="flex flex-col items-center justify-center gap-3 sm:gap-4 pt-12 sm:pt-20 max-w-4xl mx-auto pb-6 sm:pb-7 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both">
                        <DynamicGreeting className="text-2xl sm:text-3xl md:text-3xl lg:text-4xl font-medium text-balance text-center px-4 sm:px-2" />
                    </div>

                    <div className="flex flex-col items-center w-full max-w-3xl mx-auto gap-2 flex-wrap justify-center px-4 sm:px-0 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 delay-100 fill-mode-both">
                        <div className="w-full relative">
                            <div className="relative z-10">
                                <ChatInput
                                    ref={chatInputRef}
                                    onSubmit={handleChatInputSubmit}
                                    placeholder={t('describeTask')}
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
                                    memoryEnabled={memoryEnabled}
                                    onMemoryToggle={setMemoryEnabled}
                                />
                            </div>
                        </div>
                    </div>
                    {isSunaAgent && (
                        <div className="w-full max-w-3xl mx-auto mt-4 px-4 sm:px-0 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 delay-200 fill-mode-both">
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

            <Dialog open={authDialogOpen} onOpenChange={setAuthDialogOpen}>
                <BlurredDialogOverlay />
                <DialogContent className="sm:max-w-md rounded-xl bg-background border border-border">
                    <DialogHeader>
                        <div className="flex items-center justify-between">
                            <DialogTitle className="text-xl font-medium">
                                Sign in to continue
                            </DialogTitle>
                        </div>
                        <DialogDescription className="text-muted-foreground">
                            Sign in or create an account to talk with Kortix
                        </DialogDescription>
                    </DialogHeader>

                    <div className="w-full space-y-3 mt-8">
                        <Suspense fallback={<div className="h-12 bg-muted/20 rounded-full animate-pulse" />}>
                            <GoogleSignIn returnUrl="/dashboard" />
                        </Suspense>
                    </div>

                    <div className="relative my-2">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-border"></div>
                        </div>
                        <div className="relative flex justify-center text-sm">
                            <span className="px-3 bg-background text-muted-foreground font-medium">
                                or continue with email
                            </span>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <Link
                            href={`/auth?returnUrl=${encodeURIComponent('/dashboard')}`}
                            className="flex h-12 items-center justify-center w-full text-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-sm font-medium"
                            onClick={() => setAuthDialogOpen(false)}
                        >
                            Sign in with email
                        </Link>

                        <Link
                            href={`/auth?mode=signup&returnUrl=${encodeURIComponent('/dashboard')}`}
                            className="flex h-12 items-center justify-center w-full text-center rounded-full border border-border bg-background hover:bg-accent/50 transition-all font-medium"
                            onClick={() => setAuthDialogOpen(false)}
                        >
                            Create new account
                        </Link>
                    </div>

                    <div className="mt-8 text-center text-[13px] text-muted-foreground leading-relaxed">
                        By continuing, you agree to our{' '}
                        <a href="https://www.kortix.com/legal?tab=terms" target="_blank" rel="noopener noreferrer" className="text-foreground/70 hover:text-foreground underline underline-offset-2 transition-colors">
                            Terms of Service
                        </a>{' '}
                        and{' '}
                        <a href="https://www.kortix.com/legal?tab=privacy" target="_blank" rel="noopener noreferrer" className="text-foreground/70 hover:text-foreground underline underline-offset-2 transition-colors">
                            Privacy Policy
                        </a>
                    </div>
                </DialogContent>
            </Dialog>

            {agentLimitData && (
                <Suspense fallback={null}>
                    <AgentRunLimitDialog
                        open={showAgentLimitDialog}
                        onOpenChange={setShowAgentLimitDialog}
                        runningCount={agentLimitData.runningCount}
                        runningThreadIds={agentLimitData.runningThreadIds}
                        projectId={undefined}
                    />
                </Suspense>
            )}
        </section>
    );
}

