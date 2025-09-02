"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Search, ArrowLeft, Info, Zap, ChevronRight, Plus, Sparkles, CheckCircle2, Link2 } from 'lucide-react';
import { useComposioAppsWithTriggers, useComposioAppTriggers, useCreateComposioEventTrigger, ComposioTriggerType } from '@/hooks/react-query/composio/use-composio-triggers';
import { useComposioProfiles } from '@/hooks/react-query/composio/use-composio-profiles';
import { useComposioToolkitDetails } from '@/hooks/react-query/composio/use-composio';
import { toast } from 'sonner';
import { cn, truncateString } from '@/lib/utils';
import { useAgentWorkflows } from '@/hooks/react-query/agents/use-agent-workflows';
import { ComposioConnector } from '@/components/agents/composio/composio-connector';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';

interface EventBasedTriggerDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    agentId: string;
    onTriggerCreated?: (triggerId: string) => void;
}

type JSONSchema = {
    title?: string;
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
};

const ProgressStepper = ({ currentStep }: { currentStep: 'apps' | 'triggers' | 'config' }) => {
    const steps = [
        { id: 'apps', name: 'Select App', icon: <Link2 className="h-4 w-4" /> },
        { id: 'triggers', name: 'Choose Trigger', icon: <Zap className="h-4 w-4" /> },
        { id: 'config', name: 'Configure', icon: <Sparkles className="h-4 w-4" /> }
    ];

    const currentIndex = steps.findIndex(s => s.id === currentStep);

    return (
        <div className="px-6 py-3 border-b bg-muted/30">
            <div className="flex items-center space-x-1">
                {steps.map((step, index) => (
                    <React.Fragment key={step.id}>
                        <div className="flex items-center space-x-2">
                            <div className={cn(
                                "flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium",
                                index <= currentIndex
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted text-muted-foreground"
                            )}>
                                {index < currentIndex ? (
                                    <CheckCircle2 className="h-3 w-3" />
                                ) : (
                                    <span>{index + 1}</span>
                                )}
                            </div>
                            <span className={cn(
                                "text-sm font-medium",
                                index <= currentIndex
                                    ? "text-foreground"
                                    : "text-muted-foreground"
                            )}>
                                {step.name}
                            </span>
                        </div>
                        {index < steps.length - 1 && (
                            <ChevronRight className="h-4 w-4 text-muted-foreground mx-2" />
                        )}
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
};

const AppCard = ({ app, onClick, connectionStatus }: { app: any; onClick: () => void; connectionStatus: { isConnected: boolean; hasProfiles: boolean } }) => (
    <button
        onClick={onClick}
        className="group relative bg-card border border-border rounded-lg p-4 hover:bg-accent text-left w-full"
    >
        <div className="flex items-start gap-3">
            {app.logo ? (
                <div className="border flex-shrink-0 w-10 h-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
                    <img src={app.logo} alt={app.name} className="w-6 h-6 object-contain" />
                </div>
            ) : (
                <div className="flex-shrink-0 w-10 h-10 rounded-md bg-muted flex items-center justify-center">
                    <span className="text-muted-foreground font-medium">{app.name.charAt(0)}</span>
                </div>
            )}
            <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm mb-1 text-foreground group-hover:text-accent-foreground">
                    {app.name}
                </h3>
                <p className="text-xs text-muted-foreground line-clamp-2">
                    {connectionStatus.isConnected
                        ? `Create automated triggers from ${app.name} events`
                        : connectionStatus.hasProfiles
                            ? `Connect your ${app.name} account to create triggers`
                            : `Set up ${app.name} connection to get started`
                    }
                </p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        </div>

        <div className="mt-3 pt-3 border-t border-border">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                    {connectionStatus.isConnected ? (
                        <>
                            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            <span className="text-xs text-green-600 dark:text-green-400">
                                Connected
                            </span>
                        </>
                    ) : connectionStatus.hasProfiles ? (
                        <>
                            <div className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                            <span className="text-xs text-yellow-600 dark:text-yellow-400">
                                Not Connected
                            </span>
                        </>
                    ) : (
                        <>
                            <div className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                            <span className="text-xs text-gray-600 dark:text-gray-400">
                                Setup Required
                            </span>
                        </>
                    )}
                </div>
            </div>
        </div>
    </button>
);

const TriggerCard = ({ app, trigger, onClick }: { app: any; trigger: any; onClick: () => void }) => (
    <button
        onClick={onClick}
        className="group relative bg-card border border-border rounded-lg p-4 hover:bg-accent text-left w-full"
    >
        <div className="space-y-3">
            <div className="flex items-start justify-between">
                {app.logo ? (
                    <div className="border flex-shrink-0 w-10 h-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
                        <img src={app.logo} alt={app.name} className="w-6 h-6 object-contain" />
                    </div>
                ) : (
                    <div className="flex-shrink-0 w-10 h-10 rounded-md bg-muted flex items-center justify-center">
                        <Zap className="h-4 w-4 text-muted-foreground" />
                    </div>
                )}
                <Badge variant="secondary" className="text-xs text-white">
                    {trigger.type}
                </Badge>
            </div>
            <div className="space-y-1">
                <h3 className="font-medium text-sm text-foreground group-hover:text-accent-foreground">
                    {trigger.name}
                </h3>
                {trigger.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                        {trigger.description}
                    </p>
                )}
            </div>
            <div className="pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                    <code className="text-xs bg-muted px-2 py-1 rounded font-mono text-muted-foreground">
                        {truncateString(trigger.slug, 25)}
                    </code>
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                </div>
            </div>
        </div>
    </button>
);

const AppCardSkeleton = () => (
    <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex items-start gap-3 mb-3">
            <Skeleton className="w-10 h-10 rounded-md" />
            <div className="flex-1 space-y-1">
                <Skeleton className="w-3/4 h-4" />
                <Skeleton className="w-full h-3" />
                <Skeleton className="w-5/6 h-3" />
            </div>
        </div>
        <div className="pt-3 border-t border-border">
            <div className="flex justify-between items-center">
                <Skeleton className="w-16 h-3" />
                <Skeleton className="w-12 h-5" />
            </div>
        </div>
    </div>
);

const TriggerCardSkeleton = () => (
    <div className="bg-card border border-border rounded-lg p-4">
        <div className="space-y-3">
            <div className="flex items-start justify-between">
                <Skeleton className="w-8 h-8 rounded-md" />
                <Skeleton className="w-12 h-5" />
            </div>
            <div className="space-y-1">
                <Skeleton className="w-4/5 h-4" />
                <Skeleton className="w-full h-3" />
                <Skeleton className="w-3/4 h-3" />
            </div>
            <div className="pt-2 border-t border-border">
                <div className="flex justify-between items-center">
                    <Skeleton className="w-16 h-5" />
                    <Skeleton className="w-4 h-4" />
                </div>
            </div>
        </div>
    </div>
);

const DynamicConfigForm: React.FC<{
    schema?: JSONSchema;
    value: Record<string, any>;
    onChange: (v: Record<string, any>) => void;
}> = ({ schema, value, onChange }) => {
    if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
        return (
            <div className="text-center py-4 text-muted-foreground">
                <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center mb-2 mx-auto">
                    <Info className="h-4 w-4" />
                </div>
                <p className="text-sm font-medium text-foreground">Ready to go!</p>
                <p className="text-xs">This trigger doesn't require configuration</p>
            </div>
        );
    }

    const properties = schema.properties || {};
    const required = new Set(schema.required || []);

    return (
        <div className="space-y-3">
            {Object.entries(properties).map(([key, prop]: [string, any]) => {
                const label = prop.title || key;
                const type = prop.type || 'string';
                const isRequired = required.has(key);
                const examples: any[] = Array.isArray(prop.examples) ? prop.examples : [];
                const description: string = prop.description || '';
                const current = value[key] ?? prop.default ?? (type === 'number' || type === 'integer' ? '' : '');
                const handle = (val: any) => onChange({ ...value, [key]: val });

                return (
                    <div className="space-y-1" key={key}>
                        <Label className="text-sm">
                            {label} {isRequired && <span className="text-destructive">*</span>}
                        </Label>
                        {type === 'number' || type === 'integer' ? (
                            <Input
                                value={current}
                                inputMode="numeric"
                                onChange={(e) => handle(e.target.value === '' ? '' : Number(e.target.value))}
                                placeholder={examples[0] ?? ''}
                            />
                        ) : type === 'array' ? (
                            <Input
                                value={Array.isArray(current) ? current.join(',') : current}
                                onChange={(e) => handle(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
                                placeholder={examples[0] ?? 'comma,separated,values'}
                            />
                        ) : type === 'boolean' ? (
                            <div className="flex items-center space-x-2">
                                <input
                                    type="checkbox"
                                    checked={Boolean(current)}
                                    onChange={(e) => handle(e.target.checked)}
                                    className="rounded border-input"
                                />
                                <span className="text-sm">{description || label}</span>
                            </div>
                        ) : (
                            <Input value={current} onChange={(e) => handle(e.target.value)} placeholder={examples[0] ?? ''} />
                        )}
                        {description && type !== 'boolean' && <p className="text-xs text-muted-foreground">{description}</p>}
                    </div>
                );
            })}
        </div>
    );
};

export const EventBasedTriggerDialog: React.FC<EventBasedTriggerDialogProps> = ({ open, onOpenChange, agentId, onTriggerCreated }) => {
    const [step, setStep] = useState<'apps' | 'triggers' | 'config'>('apps');
    const [search, setSearch] = useState('');
    const [selectedApp, setSelectedApp] = useState<{ slug: string; name: string; logo?: string } | null>(null);
    const [selectedTrigger, setSelectedTrigger] = useState<ComposioTriggerType | null>(null);
    const [config, setConfig] = useState<Record<string, any>>({});
    const [name, setName] = useState('');
    const [prompt, setPrompt] = useState('');
    const [profileId, setProfileId] = useState('');
    const [executionType, setExecutionType] = useState<'agent' | 'workflow'>('agent');
    const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
    const [workflowInput, setWorkflowInput] = useState<Record<string, any>>({});
    const [showComposioConnector, setShowComposioConnector] = useState(false);

    const { data: appsData, isLoading: loadingApps } = useComposioAppsWithTriggers();
    const { data: triggersData, isLoading: loadingTriggers } = useComposioAppTriggers(selectedApp?.slug, !!selectedApp);
    const { data: profiles, isLoading: loadingProfiles, refetch: refetchProfiles } = useComposioProfiles(selectedApp?.slug ? { toolkit_slug: selectedApp.slug } : undefined);
    const { data: allProfiles } = useComposioProfiles(); // Get all profiles for connection status
    const { data: toolkitDetails } = useComposioToolkitDetails(selectedApp?.slug || '', { enabled: !!selectedApp });
    const { data: workflows = [], isLoading: isLoadingWorkflows } = useAgentWorkflows(agentId);

    const apps = useMemo(() => (appsData?.items || []).filter((a) => a.name.toLowerCase().includes(search.toLowerCase()) || a.slug.toLowerCase().includes(search.toLowerCase())), [appsData, search]);

    // Helper function to check if an app has connected profiles
    const getAppConnectionStatus = useMemo(() => {
        return (appSlug: string) => {
            if (!allProfiles) return { isConnected: false, hasProfiles: false };
            const appProfiles = allProfiles.filter(p => p.toolkit_slug === appSlug);
            const connectedProfiles = appProfiles.filter(p => p.is_connected);
            return {
                isConnected: connectedProfiles.length > 0,
                hasProfiles: appProfiles.length > 0
            };
        };
    }, [allProfiles]);

    const createTrigger = useCreateComposioEventTrigger();

    useEffect(() => {
        if (!open) {
            setStep('apps');
            setSelectedApp(null);
            setSelectedTrigger(null);
            setConfig({});
            setName('');
            setPrompt('');
            setProfileId('');
            setExecutionType('agent');
            setSelectedWorkflowId('');
            setWorkflowInput({});
            setShowComposioConnector(false);
        }
    }, [open]);

    useEffect(() => {
        if (selectedTrigger) {
            setName(`${selectedApp?.name || selectedTrigger.toolkit.name} → Agent`);
        }
    }, [selectedTrigger, selectedApp]);

    useEffect(() => {
        setProfileId('');
    }, [selectedApp?.slug]);

    useEffect(() => {
        if (profiles && profiles.length > 0 && !profileId) {
            const connectedProfiles = profiles.filter(p => p.is_connected);
            if (connectedProfiles.length > 0) {
                setProfileId(connectedProfiles[0].profile_id);
            }
        }
    }, [profiles, profileId]);

    const selectedWorkflow = useMemo(() => {
        return (workflows || []).find((w: any) => w.id === selectedWorkflowId);
    }, [workflows, selectedWorkflowId]);

    const { variableSpecs, templateText } = useMemo(() => {
        if (!selectedWorkflow) return { variableSpecs: [] as any[], templateText: '' };
        const stepsAny = ((selectedWorkflow as any)?.steps as any[]) || [];
        const start = stepsAny.find((s: any) => s?.name === 'Start' && s?.description === 'Click to add steps or use the Add Node button');
        const child = start?.children?.[0] ?? stepsAny[0];
        const vars = (child?.config?.playbook?.variables as any[]) || [];
        const tpl = (child?.config?.playbook?.template as string) || '';
        return { variableSpecs: vars, templateText: tpl };
    }, [selectedWorkflow]);

    const isConfigValid = useMemo(() => {
        if (!selectedTrigger?.config) return true;
        const required = new Set(selectedTrigger.config.required || []);
        return Array.from(required).every(key => {
            const value = config[key];
            return value !== undefined && value !== '' && value !== null;
        });
    }, [selectedTrigger?.config, config]);

    useEffect(() => {
        if (!selectedWorkflow || executionType !== 'workflow') return;
        if (!variableSpecs || variableSpecs.length === 0) return;
        const defaults: Record<string, any> = {};
        for (const v of variableSpecs) {
            if (v.default !== undefined && (workflowInput?.[v.key] === undefined)) {
                defaults[v.key] = v.default;
            }
        }
        if (Object.keys(defaults).length > 0) {
            setWorkflowInput(prev => ({ ...prev, ...defaults }));
        }
    }, [selectedWorkflow?.id, executionType]);

    const handleCreate = async () => {
        if (!agentId || !profileId || !selectedTrigger) return;
        try {
            const selectedProfile = profiles?.find(p => p.profile_id === profileId);
            const base: any = {
                agent_id: agentId,
                profile_id: profileId,
                slug: selectedTrigger.slug,
                trigger_config: config,
                name: name || `${selectedTrigger.toolkit.name} → ${executionType === 'agent' ? 'Agent' : 'Workflow'}`,
                connected_account_id: selectedProfile?.connected_account_id,
                toolkit_slug: selectedApp?.slug,
            };
            const payload = executionType === 'agent'
                ? { ...base, route: 'agent' as const, agent_prompt: (prompt || 'Read this') }
                : { ...base, route: 'workflow' as const, workflow_id: selectedWorkflowId, workflow_input: workflowInput };
            const result = await createTrigger.mutateAsync(payload);
            toast.success('Task created');

            if (onTriggerCreated && result?.trigger_id) {
                onTriggerCreated(result.trigger_id);
            }

            onOpenChange(false);
        } catch (e: any) {
            // Handle nested error structure from API
            let errorMessage = 'Failed to create trigger';
            console.error('Error creating trigger:', e);
            console.error('Error details:', e?.details);
            console.error('Error keys:', Object.keys(e || {}));
            if (e?.details) {
                console.error('Details keys:', Object.keys(e.details));
                console.error('Details content:', JSON.stringify(e.details, null, 2));
            }

            // Check for details property from api-client.ts error structure
            if (e?.details?.detail?.error?.message) {
                errorMessage = e.details.detail.error.message;
            } else if (e?.details?.message) {
                errorMessage = e.details.message;
            } else if (e?.details?.detail?.message) {
                errorMessage = e.details.detail.message;
            } else if (e?.message && e.message !== 'HTTP 400: Bad Request') {
                errorMessage = e.message;
            } else if (e?.response?.data?.detail?.error?.message) {
                errorMessage = e.response.data.detail.error.message;
            } else if (e?.response?.data?.message) {
                errorMessage = e.response.data.message;
            }

            toast.error(errorMessage);
        }
    };

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="max-w-4xl max-h-[90vh] p-0">
                    <div className="flex flex-col h-full max-h-[90vh]">
                        <DialogHeader className="shrink-0 px-6 py-4 border-b">
                            <div className="flex items-center gap-2">
                                {step !== 'apps' && (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => {
                                            if (step === 'triggers') {
                                                setStep('apps');
                                                setSelectedApp(null);
                                            } else if (step === 'config') {
                                                setStep('triggers');
                                                setSelectedTrigger(null);
                                                setConfig({});
                                            }
                                        }}
                                        className="h-8 w-8"
                                    >
                                        <ArrowLeft className="h-4 w-4" />
                                    </Button>
                                )}
                                <DialogTitle className="text-lg font-semibold">Create Event Trigger</DialogTitle>
                            </div>
                        </DialogHeader>
                        <ProgressStepper currentStep={step} />
                        <div className="flex-1 overflow-hidden">
                            {step === 'apps' && (
                                <div className="h-full flex flex-col">
                                    <div className="p-6 border-b flex items-center justify-between">
                                        <div>
                                            <h2 className="text-xl font-semibold">Select an Application</h2>
                                            <p className="text-sm text-muted-foreground">
                                                Choose an app to monitor for events and trigger your agent
                                            </p>
                                        </div>
                                        <div className="relative max-w-md">
                                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                            <Input
                                                placeholder="Search apps..."
                                                value={search}
                                                onChange={(e) => setSearch(e.target.value)}
                                                className="pl-10"
                                            />
                                        </div>
                                    </div>
                                    <div
                                        className="flex-1 overflow-y-auto p-6"
                                        style={{ maxHeight: 'calc(90vh - 200px)' }}
                                    >
                                        {loadingApps ? (
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                {Array.from({ length: 6 }).map((_, i) => (
                                                    <AppCardSkeleton key={i} />
                                                ))}
                                            </div>
                                        ) : apps.length === 0 ? (
                                            <div className="flex flex-col items-center justify-center py-12 text-center">
                                                <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center mb-3">
                                                    <Search className="h-6 w-6 text-muted-foreground" />
                                                </div>
                                                <h3 className="font-medium mb-1">No apps found</h3>
                                                <p className="text-sm text-muted-foreground">
                                                    {search ? `No apps match "${search}"` : 'No apps with triggers available'}
                                                </p>
                                            </div>
                                        ) : (
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                {apps.map((app) => {
                                                    const connectionStatus = getAppConnectionStatus(app.slug);
                                                    return (
                                                        <AppCard
                                                            key={app.slug}
                                                            app={app}
                                                            connectionStatus={connectionStatus}
                                                            onClick={() => {
                                                                setSelectedApp(app);
                                                                if (connectionStatus.isConnected) {
                                                                    setStep('triggers');
                                                                } else {
                                                                    // Open profile creation dialog
                                                                    setShowComposioConnector(true);
                                                                }
                                                            }}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {step === 'triggers' && selectedApp && (
                                <div className="h-full flex flex-col">
                                    <div className="p-6 border-b">
                                        <div className="flex items-center gap-3">
                                            {selectedApp.logo && (
                                                <div className="border w-10 h-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
                                                    <img src={selectedApp.logo} alt={selectedApp.name} className="w-5 h-5 object-contain" />
                                                </div>
                                            )}
                                            <div>
                                                <h2 className="font-semibold">{selectedApp.name} Triggers</h2>
                                                <p className="text-sm text-muted-foreground">Choose an event to monitor</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div
                                        className="flex-1 overflow-y-auto p-6"
                                        style={{ maxHeight: 'calc(90vh - 200px)' }}
                                    >
                                        {loadingTriggers ? (
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                {Array.from({ length: 4 }).map((_, i) => (
                                                    <TriggerCardSkeleton key={i} />
                                                ))}
                                            </div>
                                        ) : (triggersData?.items || []).length === 0 ? (
                                            <div className="flex flex-col items-center justify-center py-12 text-center">
                                                <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center mb-3">
                                                    <Zap className="h-6 w-6 text-muted-foreground" />
                                                </div>
                                                <h3 className="font-medium mb-1">No triggers available</h3>
                                                <p className="text-sm text-muted-foreground">
                                                    This app doesn't have any triggers yet.
                                                </p>
                                            </div>
                                        ) : (
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                {(triggersData?.items || []).map((trigger) => (
                                                    <TriggerCard
                                                        key={trigger.slug}
                                                        trigger={trigger}
                                                        onClick={() => {
                                                            setSelectedTrigger(trigger);
                                                            setConfig({});
                                                            setStep('config');
                                                        }}
                                                        app={selectedApp}
                                                    />
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {step === 'config' && selectedTrigger && (
                                <div className="h-full flex flex-col">
                                    <div
                                        className="flex-1 overflow-y-auto p-6"
                                        style={{ maxHeight: 'calc(90vh - 250px)' }}
                                    >
                                        <div className="max-w-2xl mx-auto space-y-6">
                                            {selectedTrigger.instructions && (
                                                <MarkdownRenderer
                                                    content={selectedTrigger.instructions}
                                                    className="text-sm w-full text-muted-foreground"
                                                />
                                            )}

                                            {(!loadingProfiles && (profiles || []).filter(p => p.is_connected).length === 0) ? (
                                                <div className="text-center py-8">
                                                    <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center mb-3 mx-auto">
                                                        <Info className="h-6 w-6 text-muted-foreground" />
                                                    </div>
                                                    <h3 className="font-medium mb-2">No Connected Profile</h3>
                                                    <p className="text-sm text-muted-foreground mb-4">
                                                        Connect {selectedApp?.name} first to create triggers.
                                                    </p>
                                                    <Button variant="outline" onClick={() => setStep('apps')}>
                                                        Back to Apps
                                                    </Button>
                                                </div>
                                            ) : (
                                                <div className="space-y-6">
                                                    <div className="border rounded-lg p-4 space-y-4">
                                                        <div>
                                                            <h3 className="font-medium mb-1">{selectedTrigger.name}</h3>
                                                            <p className="text-sm text-muted-foreground">Configure this trigger</p>
                                                        </div>
                                                        <DynamicConfigForm schema={selectedTrigger.config as any} value={config} onChange={setConfig} />
                                                    </div>

                                                    <div className="border rounded-lg p-4 space-y-4">
                                                        <div>
                                                            <h3 className="font-medium mb-1">Execution Settings</h3>
                                                            <p className="text-sm text-muted-foreground">Choose how to handle this event</p>
                                                        </div>

                                                        <div className="space-y-4">
                                                            <div className="space-y-2">
                                                                <Label className="text-sm">Connection Profile</Label>
                                                                <Select
                                                                    value={profileId}
                                                                    onValueChange={(value) => {
                                                                        if (value === '__create_new__') {
                                                                            setShowComposioConnector(true);
                                                                        } else {
                                                                            setProfileId(value);
                                                                        }
                                                                    }}
                                                                >
                                                                    <SelectTrigger>
                                                                        <SelectValue placeholder="Select a profile..." />
                                                                    </SelectTrigger>
                                                                    <SelectContent>
                                                                        {loadingProfiles ? (
                                                                            <SelectItem value="__loading__" disabled>
                                                                                <div className="flex items-center gap-2">
                                                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                                                    <span>Loading...</span>
                                                                                </div>
                                                                            </SelectItem>
                                                                        ) : (
                                                                            <>
                                                                                {(profiles || []).filter(p => p.is_connected).map((profile) => (
                                                                                    <SelectItem key={profile.profile_id} value={profile.profile_id}>
                                                                                        <div className="flex items-center gap-2">
                                                                                            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                                                                                            <span>{profile.profile_name}</span>
                                                                                        </div>
                                                                                    </SelectItem>
                                                                                ))}
                                                                                <Separator className="my-1" />
                                                                                <SelectItem value="__create_new__">
                                                                                    <div className="flex items-center gap-2 text-primary">
                                                                                        <Plus className="h-3 w-3" />
                                                                                        <span>Create New Connection</span>
                                                                                    </div>
                                                                                </SelectItem>
                                                                            </>
                                                                        )}
                                                                    </SelectContent>
                                                                </Select>
                                                            </div>

                                                            <div className="space-y-2">
                                                                <Label className="text-sm">Trigger Name</Label>
                                                                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Gmail → Agent" />
                                                            </div>

                                                            <div className="space-y-2">
                                                                <Label className="text-sm">Execution Type</Label>
                                                                <RadioGroup value={executionType} onValueChange={(v) => setExecutionType(v as 'agent' | 'workflow')}>
                                                                    <div className="flex items-center space-x-2">
                                                                        <RadioGroupItem value="agent" id="exec-agent" />
                                                                        <Label htmlFor="exec-agent" className="text-sm">Execute Agent</Label>
                                                                    </div>
                                                                    <div className="flex items-center space-x-2">
                                                                        <RadioGroupItem value="workflow" id="exec-workflow" />
                                                                        <Label htmlFor="exec-workflow" className="text-sm">Execute Workflow</Label>
                                                                    </div>
                                                                </RadioGroup>
                                                            </div>

                                                            {executionType === 'agent' ? (
                                                                <div className="space-y-2">
                                                                    <Label className="text-sm">Agent Prompt</Label>
                                                                    <Textarea
                                                                        rows={3}
                                                                        value={prompt}
                                                                        onChange={(e) => setPrompt(e.target.value)}
                                                                        placeholder="Read this"
                                                                    />
                                                                    <p className="text-xs text-muted-foreground">
                                                                        Use <code className="text-xs bg-muted px-1 rounded">payload</code> to include trigger data
                                                                    </p>
                                                                </div>
                                                            ) : (
                                                                <div className="space-y-4">
                                                                    <div className="space-y-2">
                                                                        <Label className="text-sm">Workflow</Label>
                                                                        <Select value={selectedWorkflowId} onValueChange={(v) => { setSelectedWorkflowId(v); setWorkflowInput({}); }}>
                                                                            <SelectTrigger>
                                                                                <SelectValue placeholder={isLoadingWorkflows ? 'Loading...' : 'Select workflow'} />
                                                                            </SelectTrigger>
                                                                            <SelectContent>
                                                                                {isLoadingWorkflows ? (
                                                                                    <SelectItem value="__loading__" disabled>Loading...</SelectItem>
                                                                                ) : (workflows || []).length === 0 ? (
                                                                                    <SelectItem value="__no_workflows__" disabled>No workflows available</SelectItem>
                                                                                ) : (
                                                                                    (workflows as any[]).filter(w => w.status === 'active').map((w: any) => (
                                                                                        <SelectItem key={w.id} value={w.id}>
                                                                                            {w.name}
                                                                                        </SelectItem>
                                                                                    ))
                                                                                )}
                                                                            </SelectContent>
                                                                        </Select>
                                                                    </div>

                                                                    {templateText && (
                                                                        <div className="rounded-lg border p-3 bg-muted/30 max-h-32 overflow-y-auto">
                                                                            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{templateText}</p>
                                                                        </div>
                                                                    )}

                                                                    {selectedWorkflowId && variableSpecs && (variableSpecs as any[]).length > 0 ? (
                                                                        <div className="space-y-3">
                                                                            {(variableSpecs as any[]).map((v: any) => (
                                                                                <div key={v.key} className="space-y-1">
                                                                                    <Label htmlFor={`v-${v.key}`} className="text-sm">{v.label || v.key}</Label>
                                                                                    <Input
                                                                                        id={`v-${v.key}`}
                                                                                        type={v.type === 'number' ? 'number' : 'text'}
                                                                                        value={(workflowInput?.[v.key] ?? '') as any}
                                                                                        onChange={(e) => setWorkflowInput(prev => ({ ...prev, [v.key]: v.type === 'number' ? Number(e.target.value) : e.target.value }))}
                                                                                        placeholder={v.helperText || ''}
                                                                                    />
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    ) : (
                                                                        selectedWorkflowId && (
                                                                            <div className="space-y-2">
                                                                                <Label className="text-sm">Instructions</Label>
                                                                                <Textarea
                                                                                    rows={3}
                                                                                    value={(workflowInput?.prompt as string) || ''}
                                                                                    onChange={(e) => setWorkflowInput(prev => ({ ...prev, prompt: e.target.value }))}
                                                                                    placeholder="What should the workflow do..."
                                                                                />
                                                                            </div>
                                                                        )
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Fixed Footer */}
                                    {(!loadingProfiles && (profiles || []).filter(p => p.is_connected).length > 0) && (
                                        <div className="shrink-0 border-t p-4 bg-background">
                                            <div className="flex justify-end">
                                                <Button
                                                    onClick={handleCreate}
                                                    disabled={createTrigger.isPending || !name.trim() || !profileId || !isConfigValid || (executionType === 'agent' ? !prompt.trim() : !selectedWorkflowId)}
                                                    size="sm"
                                                >
                                                    {createTrigger.isPending ? (
                                                        <>
                                                            <Loader2 className="h-3 w-3 animate-spin mr-2" />
                                                            Creating...
                                                        </>
                                                    ) : (
                                                        'Create Trigger'
                                                    )}
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {selectedApp && showComposioConnector && (
                <ComposioConnector
                    app={{
                        slug: selectedApp.slug,
                        name: selectedApp.name,
                        logo: selectedApp.logo,
                        description: `Connect your ${selectedApp.name} account to create event triggers`,
                        tags: [],
                        auth_schemes: toolkitDetails?.toolkit.auth_schemes || ['oauth'],
                        categories: []
                    }}
                    open={showComposioConnector}
                    onOpenChange={setShowComposioConnector}
                    mode="profile-only"
                    onComplete={(createdProfileId) => {
                        setProfileId(createdProfileId);
                        setShowComposioConnector(false);
                        refetchProfiles();
                        toast.success(`${selectedApp.name} profile created successfully`);
                        // Navigate to triggers step after successful profile creation
                        setStep('triggers');
                    }}
                />
            )}
        </>
    );
};