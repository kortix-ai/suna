'use client';
import { siteConfig } from '@/lib/home';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { useIsMobile } from '@/hooks/utils';
import { useState, useEffect, useRef, FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { AgentRunLimitError, BillingError } from '@/lib/api/errors';
import { useInitiateAgentMutation } from '@/hooks/dashboard/use-initiate-agent';
import { useThreadQuery } from '@/hooks/threads/use-threads';
import GoogleSignIn from '@/components/GoogleSignIn';
import { useAgents } from '@/hooks/agents/use-agents';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogOverlay,
} from '@/components/ui/dialog';
import { isLocalMode, config, isStagingMode } from '@/lib/config';
import { toast } from 'sonner';
import { PlanSelectionModal } from '@/components/billing/pricing';
import GitHubSignIn from '@/components/GithubSignIn';
import { ChatInput, ChatInputHandles } from '@/components/thread/chat-input/chat-input';
import { normalizeFilenameToNFC } from '@/lib/utils/unicode';
import { useQuery } from '@tanstack/react-query';
import { agentKeys } from '@/hooks/agents/keys';
import { getAgents } from '@/hooks/agents/utils';
import { AgentRunLimitDialog } from '@/components/thread/agent-run-limit-dialog';
import { SunaModesPanel } from '@/components/dashboard/suna-modes-panel';
import { useSunaModePersistence } from '@/stores/suna-modes-store';
import { useAgentSelection } from '@/stores/agent-selection-store';

// Custom dialog overlay with blur effect
const BlurredDialogOverlay = () => (
    <DialogOverlay className="bg-background/40 backdrop-blur-md" />
);

// Constant for localStorage key to ensure consistency
const PENDING_PROMPT_KEY = 'pendingAgentPrompt';



export function HeroSection() {
    const { hero } = siteConfig;
    const isMobile = useIsMobile();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [inputValue, setInputValue] = useState('');

    // Use centralized agent selection hook with persistence
    const {
        selectedAgentId,
        setSelectedAgent,
        initializeFromAgents,
        getCurrentAgent
    } = useAgentSelection();

    // Use centralized Suna modes persistence hook
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
    const [showPaymentModal, setShowPaymentModal] = useState(false);
    const initiateAgentMutation = useInitiateAgentMutation();
    const [initiatedThreadId, setInitiatedThreadId] = useState<string | null>(null);
    const threadQuery = useThreadQuery(initiatedThreadId || '');
    const chatInputRef = useRef<ChatInputHandles>(null);
    const [showAgentLimitDialog, setShowAgentLimitDialog] = useState(false);
    const [agentLimitData, setAgentLimitData] = useState<{
        runningCount: number;
        runningThreadIds: string[];
    } | null>(null);

    // Fetch agents for selection
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

    const agents = agentsResponse?.agents || [];

    // Initialize agent selection from agents list
    useEffect(() => {
        if (agents.length > 0) {
            initializeFromAgents(agents, undefined, setSelectedAgent);
        }
    }, [agents, initializeFromAgents, setSelectedAgent]);

    // Determine if selected agent is Suna default
    // For unauthenticated users, assume Suna is the default
    const selectedAgent = selectedAgentId
        ? agents.find(agent => agent.agent_id === selectedAgentId)
        : null;
    const isSunaAgent = !user || selectedAgent?.metadata?.is_suna_default || false;

    // Auth dialog state
    const [authDialogOpen, setAuthDialogOpen] = useState(false);

    useEffect(() => {
        if (authDialogOpen && inputValue.trim()) {
            localStorage.setItem(PENDING_PROMPT_KEY, inputValue.trim());
        }
    }, [authDialogOpen, inputValue]);

    useEffect(() => {
        if (authDialogOpen && user && !isLoading) {
            setAuthDialogOpen(false);
            router.push('/dashboard');
        }
    }, [user, isLoading, authDialogOpen, router]);

    useEffect(() => {
        if (threadQuery.data && initiatedThreadId) {
            const thread = threadQuery.data;
            if (thread.project_id) {
                router.push(`/projects/${thread.project_id}/thread/${initiatedThreadId}`);
            } else {
                router.push(`/agents/${initiatedThreadId}`);
            }
            setInitiatedThreadId(null);
        }
    }, [threadQuery.data, initiatedThreadId, router]);

    // Handle ChatInput submission
    const handleChatInputSubmit = async (
        message: string,
        options?: { model_name?: string; enable_thinking?: boolean }
    ) => {
        if ((!message.trim() && !chatInputRef.current?.getPendingFiles().length) || isSubmitting) return;

        // If user is not logged in, save prompt and show auth dialog
        if (!user && !isLoading) {
            localStorage.setItem(PENDING_PROMPT_KEY, message.trim());
            setAuthDialogOpen(true);
            return;
        }

        // User is logged in, create the agent with files like dashboard does
        setIsSubmitting(true);
        try {
            const files = chatInputRef.current?.getPendingFiles() || [];
            localStorage.removeItem(PENDING_PROMPT_KEY);

            const formData = new FormData();
            formData.append('prompt', message);

            // Add selected agent if one is chosen
            if (selectedAgentId) {
                formData.append('agent_id', selectedAgentId);
            }

            // Add files if any
            files.forEach((file) => {
                const normalizedName = normalizeFilenameToNFC(file.name);
                formData.append('files', file, normalizedName);
            });

            if (options?.model_name) formData.append('model_name', options.model_name);
            formData.append('enable_thinking', String(options?.enable_thinking ?? false));
            formData.append('reasoning_effort', 'low');
            formData.append('stream', 'true');
            formData.append('enable_context_manager', 'false');

            const result = await initiateAgentMutation.mutateAsync(formData);

            if (result.thread_id) {
                setInitiatedThreadId(result.thread_id);
            } else {
                throw new Error('Agent initiation did not return a thread_id.');
            }

            chatInputRef.current?.clearPendingFiles();
            setInputValue('');
        } catch (error: any) {
            if (error instanceof BillingError) {
                setShowPaymentModal(true);
            } else if (error instanceof AgentRunLimitError) {
                const { running_thread_ids, running_count } = error.detail;

                setAgentLimitData({
                    runningCount: running_count,
                    runningThreadIds: running_thread_ids,
                });
                setShowAgentLimitDialog(true);
            } else {
                const isConnectionError =
                    error instanceof TypeError &&
                    error.message.includes('Failed to fetch');
                if (!isLocalMode() || isConnectionError) {
                    toast.error(
                        error.message || 'Failed to create agent. Please try again.',
                    );
                }
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <section id="hero" className="w-full relative overflow-hidden">
            <PlanSelectionModal
                open={showPaymentModal}
                onOpenChange={setShowPaymentModal}
            />
            <div className="relative flex flex-col items-center w-full px-4 sm:px-6 pb-8 sm:pb-10">
                {/* Animated background */}
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

                <div className="relative z-10 pt-16 sm:pt-24 md:pt-32 mx-auto h-full w-full max-w-6xl flex flex-col items-center justify-center">

                    <div className="flex flex-col items-center justify-center gap-3 sm:gap-4 pt-8 sm:pt-20 max-w-4xl mx-auto pb-7">
                        <h1 className="text-2xl md:text-3xl lg:text-4xl font-medium tracking-tighter text-balance text-center px-2">
                            What do you want to get done?
                        </h1>
                    </div>

                    <div className="flex flex-col items-center w-full max-w-3xl mx-auto gap-2 flex-wrap justify-center px-2 sm:px-0">
                        <div className="w-full relative">
                            <div className="relative z-10">
                                <ChatInput
                                    ref={chatInputRef}
                                    onSubmit={handleChatInputSubmit}
                                    placeholder="Describe the task you want your Worker to complete..."
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

                    {/* Modes Panel - Below chat input, visible for Suna agent */}
                    {isSunaAgent && (
                        <div className="w-full max-w-3xl mx-auto mt-4 px-2 sm:px-0">
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
                        </div>
                    )}


                </div>

            </div>

            {/* Auth Dialog */}
            <Dialog open={authDialogOpen} onOpenChange={setAuthDialogOpen}>
                <BlurredDialogOverlay />
                <DialogContent className="sm:max-w-md rounded-xl bg-background border border-border">
                    <DialogHeader>
                        <div className="flex items-center justify-between">
                            <DialogTitle className="text-xl font-medium">
                                Sign in to continue
                            </DialogTitle>
                            {/* <button 
                onClick={() => setAuthDialogOpen(false)}
                className="rounded-full p-1 hover:bg-muted transition-colors"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button> */}
                        </div>
                        <DialogDescription className="text-muted-foreground">
                            Sign in or create an account to talk with Kortix
                        </DialogDescription>
                    </DialogHeader>

                    {/* OAuth Sign In */}
                    <div className="w-full space-y-3 mt-8">
                        <GoogleSignIn returnUrl="/dashboard" />
                        <GitHubSignIn returnUrl="/dashboard" />
                    </div>

                    {/* Divider */}
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

                    {/* Sign in options */}
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
                <AgentRunLimitDialog
                    open={showAgentLimitDialog}
                    onOpenChange={setShowAgentLimitDialog}
                    runningCount={agentLimitData.runningCount}
                    runningThreadIds={agentLimitData.runningThreadIds}
                    projectId={undefined} // Hero section doesn't have a specific project context
                />
            )}
        </section>
    );
}

