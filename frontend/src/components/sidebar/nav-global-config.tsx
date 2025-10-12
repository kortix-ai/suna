'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Zap, BookOpen, ChevronRight } from 'lucide-react';
import { useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';

export function NavGlobalConfig() {
    const { setOpenMobile, isMobile } = useSidebar();
    const pathname = usePathname();
    const router = useRouter();

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
                    Global Config
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
                    <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0">
                        <Zap className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <span className="flex-1 truncate">Triggers</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                </div>
            </SpotlightCard>

            {/* Knowledge Base Option */}
            <SpotlightCard
                className={cn(
                    "transition-colors cursor-pointer",
                    isKnowledgeBaseActive ? "bg-muted" : "bg-transparent"
                )}
            >
                <div
                    className="flex items-center gap-3 p-2.5 text-sm"
                    onClick={() => handleNavigation('/knowledge')}
                >
                    <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0">
                        <BookOpen className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <span className="flex-1 truncate">Knowledge Base</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                </div>
            </SpotlightCard>
        </div>
    );
}
