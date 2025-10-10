'use client';

import React, { useState, useMemo } from 'react';
import { Zap, Search, Plus, Play, Pause, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { toast } from 'sonner';
import {
    useAgentTriggers,
    useCreateTrigger,
    useUpdateTrigger,
    useDeleteTrigger,
    useToggleTrigger,
    useTriggerProviders
} from '@/hooks/react-query/triggers';
import { TriggerCreationDialog } from '@/components/triggers/trigger-creation-dialog';

interface TriggersScreenProps {
    agentId: string;
}

export function TriggersScreen({ agentId }: TriggersScreenProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [configuringProvider, setConfiguringProvider] = useState<any>(null);
    const [editingTrigger, setEditingTrigger] = useState<any>(null);

    const { data: triggers = [], isLoading } = useAgentTriggers(agentId);
    const { data: providers = [] } = useTriggerProviders();
    const createTriggerMutation = useCreateTrigger();
    const updateTriggerMutation = useUpdateTrigger();
    const deleteTriggerMutation = useDeleteTrigger();
    const toggleTriggerMutation = useToggleTrigger();

    const runningTriggers = useMemo(
        () => triggers.filter((trigger) => trigger.is_active),
        [triggers]
    );

    const pausedTriggers = useMemo(
        () => triggers.filter((trigger) => !trigger.is_active),
        [triggers]
    );

    const handleToggleTrigger = async (trigger: any) => {
        try {
            await toggleTriggerMutation.mutateAsync({
                triggerId: trigger.trigger_id,
                isActive: !trigger.is_active,
            });
            toast.success(`Trigger ${!trigger.is_active ? 'enabled' : 'disabled'}`);
        } catch (error) {
            toast.error('Failed to toggle trigger');
        }
    };

    const handleEditTrigger = (trigger: any) => {
        setEditingTrigger(trigger);

        const provider = providers.find(p => p.provider_id === trigger.provider_id);
        if (provider) {
            setConfiguringProvider(provider);
        } else {
            setConfiguringProvider({
                provider_id: trigger.provider_id,
                name: trigger.trigger_type,
                description: '',
                trigger_type: trigger.trigger_type,
                webhook_enabled: !!trigger.webhook_url,
                config_schema: {}
            });
        }
    };

    const handleDeleteTrigger = async (trigger: any) => {
        try {
            await deleteTriggerMutation.mutateAsync({
                triggerId: trigger.trigger_id,
                agentId: trigger.agent_id
            });
            toast.success('Trigger deleted successfully');
        } catch (error) {
            toast.error('Failed to delete trigger');
        }
    };

    const handleSaveTrigger = async (config: any) => {
        try {
            if (editingTrigger) {
                await updateTriggerMutation.mutateAsync({
                    triggerId: editingTrigger.trigger_id,
                    name: config.name,
                    description: config.description,
                    config: config.config,
                    is_active: config.is_active,
                });
                toast.success('Trigger updated successfully');
            } else {
                await createTriggerMutation.mutateAsync({
                    agentId,
                    provider_id: configuringProvider!.provider_id,
                    name: config.name,
                    description: config.description,
                    config: config.config,
                });
                toast.success('Trigger created successfully');
            }
        } catch (error: any) {
            toast.error(error.message || 'Failed to save trigger');
        }
        setConfiguringProvider(null);
        setEditingTrigger(null);
    };

    const handleCreateNew = () => {
        // For now, open with a default provider (schedule)
        // In the future, you might want to show a provider selection dialog first
        const defaultProvider = providers.find(p => p.provider_id === 'schedule') || providers[0];
        if (defaultProvider) {
            setConfiguringProvider(defaultProvider);
        } else {
            toast.error('No trigger providers available');
        }
    };

    return (
        <div className="flex-1 overflow-auto pb-6">
            {/* Search Bar */}
            <div className="flex items-center justify-between pb-4 px-1 pt-1">
                <div className="max-w-md w-md">
                    <div className="relative">
                        <Input
                            type="text"
                            placeholder="Search"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-10"
                        />
                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                            <Search className="h-4 w-4" />
                        </div>
                    </div>
                </div>
                <Button
                    variant="default"
                    size="sm"
                    onClick={handleCreateNew}
                    className="h-10 px-4 rounded-xl gap-2"
                >
                    <Plus className="h-4 w-4" />
                    Create new
                </Button>
            </div>

            {/* Triggers Content */}
            <div className="px-1">
                {runningTriggers.length === 0 && pausedTriggers.length === 0 ? (
                    <div className="text-center py-12 px-6">
                        <div className="mx-auto w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4 border">
                            <Zap className="h-6 w-6 text-muted-foreground" />
                        </div>
                        <h4 className="text-sm font-semibold text-foreground mb-2">
                            No triggers configured
                        </h4>
                        <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
                            Set up triggers to automate this agent
                        </p>
                    </div>
                ) : (
                    <>
                        {/* Running Section */}
                        {runningTriggers.length > 0 && (
                            <section className="mb-6">
                                <h2 className="text-sm font-medium mb-3">Running</h2>
                                <div className="space-y-2">
                                    {runningTriggers.map((trigger) => (
                                        <TriggerCard
                                            key={trigger.trigger_id}
                                            trigger={trigger}
                                            onToggle={() => handleToggleTrigger(trigger)}
                                            onEdit={() => handleEditTrigger(trigger)}
                                            onDelete={() => handleDeleteTrigger(trigger)}
                                        />
                                    ))}
                                </div>
                            </section>
                        )}

                        {/* Paused Section */}
                        {pausedTriggers.length > 0 && (
                            <section>
                                <h2 className="text-sm font-medium mb-3">Paused</h2>
                                <div className="space-y-2">
                                    {pausedTriggers.map((trigger) => (
                                        <TriggerCard
                                            key={trigger.trigger_id}
                                            trigger={trigger}
                                            onToggle={() => handleToggleTrigger(trigger)}
                                            onEdit={() => handleEditTrigger(trigger)}
                                            onDelete={() => handleDeleteTrigger(trigger)}
                                        />
                                    ))}
                                </div>
                            </section>
                        )}
                    </>
                )}
            </div>

            {/* Creation/Edit Dialog */}
            {configuringProvider && (
                <TriggerCreationDialog
                    open={!!configuringProvider}
                    onOpenChange={() => {
                        setConfiguringProvider(null);
                        setEditingTrigger(null);
                    }}
                    type={configuringProvider.provider_id === 'schedule' ? 'schedule' : 'event'}
                    isEditMode={!!editingTrigger}
                    existingTrigger={editingTrigger}
                    onTriggerCreated={handleSaveTrigger}
                    onTriggerUpdated={handleSaveTrigger}
                />
            )}
        </div>
    );
}

interface TriggerCardProps {
    trigger: any;
    onToggle: () => void;
    onEdit: () => void;
    onDelete: () => void;
}

function TriggerCard({ trigger, onToggle, onEdit, onDelete }: TriggerCardProps) {
    return (
        <SpotlightCard className="bg-card border border-border">
            <div className="flex items-center justify-between p-5">
                <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-card border border-border/50 flex-shrink-0">
                        <Zap className="h-5 w-5 text-foreground" />
                    </div>

                    <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-foreground mb-0.5">{trigger.name}</h3>
                        <p className="text-sm text-muted-foreground truncate">
                            {trigger.description || 'No description'}
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2 ml-4">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onToggle}
                        className="h-12 w-12 bg-primary border border-border hover:bg-muted text-background hover:text-foreground"
                    >
                        {trigger.is_active ? (
                            <Pause className="h-7 w-7 " />
                        ) : (
                            <Play className="h-5 w-5 ml-0.5" />
                        )}
                    </Button>

                    <Button
                        variant="outline"
                        size="icon"
                        onClick={onEdit}
                        className="h-12 w-12 bg-card border border-border hover:bg-muted"
                    >
                        <Settings className="h-5 w-5" />
                    </Button>
                </div>
            </div>
        </SpotlightCard>
    );
}
