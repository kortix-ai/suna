'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircle, Clock, Frown } from 'lucide-react';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { ThreadIcon } from './thread-icon';
import { useThreads } from '@/hooks/sidebar/use-sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useSidebar } from '@/components/ui/sidebar';
import { useTranslations } from 'next-intl';

interface ThreadSearchModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

type ThreadWithProject = {
    threadId: string;
    projectId: string;
    projectName: string;
    url: string;
    updatedAt: string;
    iconName?: string;
};

export function ThreadSearchModal({ open, onOpenChange }: ThreadSearchModalProps) {
    const [search, setSearch] = useState('');
    const router = useRouter();
    const isMobile = useIsMobile();
    const { setOpenMobile } = useSidebar();
    const t = useTranslations('sidebar');

    // Reduced limit from 50 to 20 to reduce API response size
    const { data: threadsResponse } = useThreads({ page: 1, limit: 20 });

    // Process threads directly from backend data - backend already provides project info
    const combinedThreads = useMemo(() => {
        const threads = threadsResponse?.threads || [];
        if (!threads.length) return [];
        
        const processed: ThreadWithProject[] = [];
        
        for (const thread of threads) {
            const projectId = thread.project_id;
            const project = thread.project;
            
            if (!projectId || !project) continue;
            
            processed.push({
                threadId: thread.thread_id,
                projectId: projectId,
                projectName: project.name || 'Unnamed Project',
                url: `/projects/${projectId}/thread/${thread.thread_id}`,
                updatedAt: thread.updated_at || project.updated_at || new Date().toISOString(),
                iconName: project.icon_name,
            });
        }
        
        return processed.sort((a, b) => 
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
    }, [threadsResponse]);

    const filtered = search
        ? combinedThreads.filter((t) =>
            t.projectName.toLowerCase().includes(search.toLowerCase())
        )
        : combinedThreads.slice(0, 50);

    const handleSelect = (url: string) => {
        onOpenChange(false);
        setSearch('');
        router.push(url);
        if (isMobile) setOpenMobile(false);
    };

    useEffect(() => {
        if (!open) setSearch('');
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl p-0 overflow-hidden bg-background" hideCloseButton>
                <VisuallyHidden>
                    <DialogTitle>Search chats</DialogTitle>
                </VisuallyHidden>
                <Command className="bg-background border-0" shouldFilter={false}>
                    <div className="px-4 py-3 border-b">
                        <CommandInput
                            placeholder="Search chats..."
                            value={search}
                            onValueChange={setSearch}
                            className=" px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                        />
                    </div>
                    <CommandList className="max-h-[400px] p-3">
                        {combinedThreads.length === 0 && !search ? (
                            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                                <Frown className="h-12 w-12 text-muted-foreground/40 mb-3" />
                                <p className="text-sm text-muted-foreground">
                                    {t('noConversations')}
                                </p>
                            </div>
                        ) : filtered.length === 0 ? (
                            <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
                                No chats found
                            </CommandEmpty>
                        ) : (
                            <CommandGroup className="p-0 [&_[cmdk-group-heading]]:hidden">
                                <div className="space-y-1.5">
                                    {filtered.map((thread) => (
                                        <CommandItem
                                            key={thread.threadId}
                                            value={thread.threadId}
                                            onSelect={() => handleSelect(thread.url)}
                                            className="p-0 rounded-2xl"
                                        >
                                            <SpotlightCard className="w-full cursor-pointer">
                                                <div className="flex items-center gap-3 px-3 py-2">
                                                    <div className="flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border shrink-0">
                                                        <ThreadIcon
                                                            iconName={thread.iconName}
                                                            className="text-muted-foreground"
                                                            size={16}
                                                        />
                                                    </div>
                                                    <span className="flex-1 truncate text-sm">{thread.projectName}</span>
                                                    <Clock className="h-3 w-3 opacity-50 shrink-0" />
                                                </div>
                                            </SpotlightCard>
                                        </CommandItem>
                                    ))}
                                </div>
                            </CommandGroup>
                        )}
                    </CommandList>
                </Command>
            </DialogContent>
        </Dialog>
    );
}
