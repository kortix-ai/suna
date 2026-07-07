'use client';

import { useCallback, useState } from 'react';

import {
  ChatGptSubscriptionConnectDialog,
  useShowChatGptConnectPrompt,
} from '@/components/projects/chatgpt-subscription-connect';
import Hint from '@/components/ui/hint';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { Icon } from '@/features/icon/icon';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';

function useChatGptConnectDialog(projectId: string) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  const openDialog = useCallback(() => {
    setOpen(true);
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  return { open, setOpen, openDialog };
}

export function ProjectChatGptConnectNavItem({ projectId }: { projectId: string }) {
  const { show } = useShowChatGptConnectPrompt(projectId);
  const { open, setOpen, openDialog } = useChatGptConnectDialog(projectId);

  if (!show) return null;

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={openDialog}

     className="text-sm! font-medium [&_svg]:size-4! flex items-center justify-start group/customize-button"
        >
          <Icon.OpenAI className="text-foreground" />
          Connect GPT subscription
        </SidebarMenuButton>
      </SidebarMenuItem>
      <ChatGptSubscriptionConnectDialog projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ProjectChatGptConnectRailItem({ projectId }: { projectId: string }) {
  const { show } = useShowChatGptConnectPrompt(projectId);
  const { open, setOpen, openDialog } = useChatGptConnectDialog(projectId);

  if (!show) return null;

  return (
    <>
      <Hint label="Connect GPT subscription">
        <SidebarMenuButton
          type="button"
          aria-label="Connect GPT subscription"
          onClick={openDialog}
          className={cn('border-border/60 bg-muted/30 hover:bg-muted/50 border')}
        >
          <Icon.OpenAI className="text-foreground" />
        </SidebarMenuButton>
      </Hint>
      <ChatGptSubscriptionConnectDialog projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  );
}
