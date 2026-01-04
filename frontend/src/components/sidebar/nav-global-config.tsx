'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Zap, BookOpen, ChevronRight, Plus, Clock, PlugZap, Loader2 } from 'lucide-react';
import { useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { Button } from '../ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TriggerCreationDialog } from '@/components/triggers/trigger-creation-dialog';
import { useAllTriggers } from '@/hooks/triggers/use-all-triggers';
import Link from 'next/link';

export function NavGlobalConfig() {
    const { setOpenMobile, isMobile } = useSidebar();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const router = useRouter();
    const [triggerDialogType, setTriggerDialogType] = useState<'schedule' | 'event' | null>(null);
    const { data: triggers = [], isLoading } = useAllTriggers();

    const isTriggersActive = pathname?.includes('/triggers');
    const activeTriggerIdFromUrl = searchParams.get('trigger_id');
    const isKnowledgeBaseActive = pathname?.includes('/knowledge');

    const handleNavigation = (path: string) => {
        router.push(path);
        if (isMobile) {
            setOpenMobile(false);
        }
    };

    return (
        <div className="space-y-1">
            {/* Section Header */}
            <div className="py-2 mt-4 first:mt-2">
                <div className="text-xs font-medium text-muted-foreground pl-2.5">
                    Trigger Config
                </div>
            </div>

            {/* Triggers Option */}
            <SpotlightCard
                className={cn(
                    "transition-all cursor-pointer rounded-2xl",
                    isTriggersActive ? "border-[1.5px] bg-background dark:bg-card" : "bg-transparent"
                )}
            >
                <div
                    className="flex items-center gap-2.5 py-2 px-2 text-sm"
                    onClick={() => handleNavigation('/triggers')}
                >
                    <Zap className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="flex-1 truncate">All Triggers</span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                </div>
            </SpotlightCard>

            {/* Individual Triggers List */}
            {isLoading ? (
                <div className="space-y-1 mt-1">
                    {Array.from({ length: 2 }).map((_, index) => (
                        <div key={`skeleton-${index}`} className="flex items-center gap-2.5 px-2 py-2">
                            <div className="h-4 w-4 bg-muted/30 rounded animate-pulse"></div>
                            <div className="h-3.5 bg-muted/30 rounded flex-1 animate-pulse"></div>
                        </div>
                    ))}
                </div>
            ) : triggers.length > 0 ? (
                <div className="space-y-1 mt-1">
                    {triggers.slice(0, 5).map((trigger) => {
                        const isActive = activeTriggerIdFromUrl === trigger.trigger_id;
                        return (
                            <SpotlightCard
                                key={trigger.trigger_id}
                                className={cn(
                                    "transition-all cursor-pointer rounded-2xl",
                                    isActive ? "border-[1.5px] bg-background dark:bg-card" : "bg-transparent"
                                )}
                            >
                                <div
                                    className="flex items-center gap-2.5 py-2 px-2 text-sm"
                                    onClick={() => {
                                        router.push(`/triggers?trigger_id=${trigger.trigger_id}`);
                                        if (isMobile) setOpenMobile(false);
                                    }}
                                >
                                    <Zap className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                                    <span className="flex-1 truncate text-muted-foreground">{trigger.name}</span>
                                </div>
                            </SpotlightCard>
                        );
                    })}
                </div>
            ) : null}

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className="w-full shadow-none justify-center items-center h-8 px-3 bg-background mt-2 text-xs"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Add Trigger
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                    <DropdownMenuItem onClick={() => setTriggerDialogType('schedule')} className='rounded-lg'>
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <div className="flex flex-col">
                            <span>Scheduled Trigger</span>
                            <span className="text-xs text-muted-foreground">
                                Schedule a trigger to run at a specific time
                            </span>
                        </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setTriggerDialogType('event')} className='rounded-lg'>
                        <PlugZap className="h-4 w-4 text-muted-foreground" />
                        <div className="flex flex-col">
                            <span>Event-based Trigger</span>
                            <span className="text-xs text-muted-foreground">
                                Make a trigger to run when an event occurs
                            </span>
                        </div>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            {/* Trigger Creation Dialog */}
            {triggerDialogType && (
                <TriggerCreationDialog
                    open={!!triggerDialogType}
                    onOpenChange={(open) => {
                        if (!open) {
                            setTriggerDialogType(null);
                        }
                    }}
                    type={triggerDialogType}
                    onTriggerCreated={(triggerId) => {
                        setTriggerDialogType(null);
                        // Navigate to triggers page to see the new trigger
                        router.push('/triggers');
                        if (isMobile) {
                            setOpenMobile(false);
                        }
                    }}
                />
            )}

        </div>
    );
}
