'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Zap, BookOpen, ChevronRight, Plus, Clock, PlugZap } from 'lucide-react';
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
import Link from 'next/link';

export function NavGlobalConfig() {
    const { setOpenMobile, isMobile } = useSidebar();
    const pathname = usePathname();
    const router = useRouter();
    const [triggerDialogType, setTriggerDialogType] = useState<'schedule' | 'event' | null>(null);

    const isTriggersActive = pathname?.includes('/triggers');
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
                    "transition-colors cursor-pointer",
                    isTriggersActive ? "bg-muted" : "bg-transparent"
                )}
            >
                <div
                    className="flex items-center gap-3 p-2.5 text-sm"
                    onClick={() => handleNavigation('/triggers')}
                >
                    <div className="flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0">
                        <Zap className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <span className="flex-1 truncate">Triggers</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                </div>
            </SpotlightCard>

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className="w-full shadow-none justify-center items-center h-10 px-4 bg-background mt-3"
                    >
                        <Plus className="h-4 w-4" />
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
