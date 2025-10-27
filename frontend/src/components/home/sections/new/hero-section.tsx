'use client';
import { HeroVideoSection } from '@/components/home/sections/hero-video-section';
import { siteConfig } from '@/lib/home';
import { ArrowRight, Github, X, AlertCircle, Square } from 'lucide-react';
import { AnimatedBg } from '@/components/home/ui/AnimatedBg';
import { useIsMobile } from '@/hooks/use-mobile';
import { useState, useEffect, useRef, FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import {
    BillingError,
    AgentRunLimitError,
} from '@/lib/api';
import { useInitiateAgentMutation } from '@/hooks/react-query/dashboard/use-initiate-agent';
import { useThreadQuery } from '@/hooks/react-query/threads/use-threads';
import { generateThreadName } from '@/lib/actions/threads';
import GoogleSignIn from '@/components/GoogleSignIn';
import { useAgents } from '@/hooks/react-query/agents/use-agents';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogOverlay,
} from '@/components/ui/dialog';
import { BillingErrorAlert } from '@/components/billing/usage-limit-alert';
import { useBillingError } from '@/hooks/useBillingError';
import { useAccounts } from '@/hooks/use-accounts';
import { isLocalMode, config, isStagingMode } from '@/lib/config';
import { toast } from 'sonner';
import { BillingModal } from '@/components/billing/billing-modal';
import GitHubSignIn from '@/components/GithubSignIn';
import { ChatInput, ChatInputHandles } from '@/components/thread/chat-input/chat-input';
import { normalizeFilenameToNFC } from '@/lib/utils/unicode';
import { createQueryHook } from '@/hooks/use-query';
import { agentKeys } from '@/hooks/react-query/agents/keys';
import { getAgents } from '@/hooks/react-query/agents/utils';
import { AgentRunLimitDialog } from '@/components/thread/agent-run-limit-dialog';
import { Examples } from '@/components/dashboard/examples';
import { SunaModesPanel } from '@/components/dashboard/suna-modes-panel';

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
    const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>();
    const [selectedMode, setSelectedMode] = useState<string | null>(null);
    const [selectedCharts, setSelectedCharts] = useState<string[]>([]);
    const [selectedOutputFormat, setSelectedOutputFormat] = useState<string | null>(null);
    const router = useRouter();
    const { user, isLoading } = useAuth();
    const { billingError, handleBillingError, clearBillingError } =
        useBillingError();
    const { data: accounts } = useAccounts();
    const personalAccount = accounts?.find((account) => account.personal_account);
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
    const { data: agentsResponse } = createQueryHook(
        agentKeys.list({
            limit: 100,
            sort_by: 'name',
            sort_order: 'asc'
        }),
        () => getAgents({
            limit: 100,
            sort_by: 'name',
            sort_order: 'asc'
        }),
        {
            enabled: !!user && !isLoading,
            staleTime: 5 * 60 * 1000,
            gcTime: 10 * 60 * 1000,
        }
    )();

    const agents = agentsResponse?.agents || [];

    // Determine if selected agent is Suna default
    const selectedAgent = selectedAgentId
        ? agents.find(agent => agent.agent_id === selectedAgentId)
        : null;
    const isSunaAgent = selectedAgent?.metadata?.is_suna_default || false;

    // Auth dialog state
    const [authDialogOpen, setAuthDialogOpen] = useState(false);

    // Reset data selections when mode changes
    useEffect(() => {
        if (selectedMode !== 'data') {
            setSelectedCharts([]);
            setSelectedOutputFormat(null);
        }
    }, [selectedMode]);

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
            <BillingModal
                open={showPaymentModal}
                onOpenChange={setShowPaymentModal}
                showUsageLimitAlert={true}
            />
            <div className="relative flex flex-col items-center w-full px-4 sm:px-6 pb-8 sm:pb-10">
                {/* Animated background */}
                <AnimatedBg variant="hero" />

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
                                    placeholder="Describe the agent you want to build or the task you want completed..."
                                    loading={isSubmitting}
                                    disabled={isSubmitting}
                                    value={inputValue}
                                    onChange={setInputValue}
                                    isLoggedIn={!!user}
                                    selectedAgentId={selectedAgentId}
                                    onAgentSelect={setSelectedAgentId}
                                    autoFocus={false}
                                    enableAdvancedConfig={false}
                                    selectedMode={selectedMode}
                                    onModeDeselect={() => setSelectedMode(null)}
                                    selectedCharts={selectedCharts}
                                    selectedOutputFormat={selectedOutputFormat}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Modes Panel - Below chat input, only show when user is logged in */}
                    {(isStagingMode() || isLocalMode()) && (isSunaAgent || !user) && (
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
                            Sign in or create an account to talk with Suna
                        </DialogDescription>
                    </DialogHeader>



                    {/* OAuth Sign In */}
                    <div className="w-full">
                        <GoogleSignIn returnUrl="/dashboard" />
                        <GitHubSignIn returnUrl="/dashboard" />
                    </div>

                    {/* Divider */}
                    <div className="relative my-6">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-border"></div>
                        </div>
                        <div className="relative flex justify-center text-sm">
                            <span className="px-2 bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] text-muted-foreground">
                                or continue with email
                            </span>
                        </div>
                    </div>

                    {/* Sign in options */}
                    <div className="space-y-4 pt-4">
                        <Link
                            href={`/auth?returnUrl=${encodeURIComponent('/dashboard')}`}
                            className="flex h-12 items-center justify-center w-full text-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-md"
                            onClick={() => setAuthDialogOpen(false)}
                        >
                            Sign in with email
                        </Link>

                        <Link
                            href={`/auth?mode=signup&returnUrl=${encodeURIComponent('/dashboard')}`}
                            className="flex h-12 items-center justify-center w-full text-center rounded-full border border-border bg-background hover:bg-accent/20 transition-all"
                            onClick={() => setAuthDialogOpen(false)}
                        >
                            Create new account
                        </Link>
                    </div>

                    <div className="mt-4 text-center text-xs text-muted-foreground">
                        By continuing, you agree to our{' '}
                        <Link href="/terms" className="text-primary hover:underline">
                            Terms of Service
                        </Link>{' '}
                        and{' '}
                        <Link href="/privacy" className="text-primary hover:underline">
                            Privacy Policy
                        </Link>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Add Billing Error Alert here */}
            <BillingErrorAlert
                message={billingError?.message}
                currentUsage={billingError?.currentUsage}
                limit={billingError?.limit}
                accountId={personalAccount?.account_id}
                onDismiss={clearBillingError}
                isOpen={!!billingError}
            />

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