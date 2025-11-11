'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircle, Clock } from 'lucide-react';
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
import { useThreads, useProjects, processThreadsWithProjects } from '@/hooks/sidebar/use-sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useSidebar } from '@/components/ui/sidebar';

interface ThreadSearchModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function ThreadSearchModal({ open, onOpenChange }: ThreadSearchModalProps) {
    const [search, setSearch] = useState('');
    const router = useRouter();
    const isMobile = useIsMobile();
    const { setOpenMobile } = useSidebar();

    const { data: threads = [] } = useThreads();
    const { data: projects = [] } = useProjects();

    const combinedThreads = processThreadsWithProjects(threads, projects);

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
            <DialogContent className="max-w-2xl p-0 overflow-hidden bg-background">
                <VisuallyHidden>
                    <DialogTitle>Search chats</DialogTitle>
                </VisuallyHidden>
                <Command className="bg-background border-0" shouldFilter={false}>
                    <div className="px-4 py-3">
                        <CommandInput
                            placeholder="Search chats..."
                            value={search}
                            onValueChange={setSearch}
                            className=" px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                        />
                    </div>
                    <CommandList className="max-h-[400px] p-3">
                        <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
                            No chats found
                        </CommandEmpty>
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
                    </CommandList>
                </Command>
            </DialogContent>
        </Dialog>
    );
}
