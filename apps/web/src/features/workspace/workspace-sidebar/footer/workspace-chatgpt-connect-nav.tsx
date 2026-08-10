'use client';

import { useCallback, useState } from 'react';

import {
  ChatGptSubscriptionConnectDialog,
  useShowChatGptConnectPrompt,
} from '@/components/workspaces/chatgpt-subscription-connect';
import Hint from '@/components/ui/hint';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { OpenAI } from '@/features/icon/icons/open-ai';
import { useIsMobile } from '@/hooks/utils';

function useChatGptConnectDialog(workspaceId: string) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  const openDialog = useCallback(() => {
    setOpen(true);
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  return { open, setOpen, openDialog };
}

export function WorkspaceChatGptConnectNavItem({ workspaceId }: { workspaceId: string }) {
  const { show } = useShowChatGptConnectPrompt(workspaceId);
  const { open, setOpen, openDialog } = useChatGptConnectDialog(workspaceId);

  if (!show) return null;

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={openDialog}

          className="group/customize-button flex items-center justify-start text-sm! font-medium [&_svg]:size-4!"
        >
          <OpenAI className="text-foreground" />
          Connect GPT subscription
        </SidebarMenuButton>
      </SidebarMenuItem>
      <ChatGptSubscriptionConnectDialog workspaceId={workspaceId} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function WorkspaceChatGptConnectRailItem({ workspaceId }: { workspaceId: string }) {
  const { show } = useShowChatGptConnectPrompt(workspaceId);
  const { open, setOpen, openDialog } = useChatGptConnectDialog(workspaceId);

  if (!show) return null;

  return (
    <>
      <Hint label="Connect GPT subscription">
        <SidebarMenuButton type="button" aria-label="Connect GPT subscription" onClick={openDialog}>
          <OpenAI className="text-foreground size-4.5!" />
        </SidebarMenuButton>
      </Hint>
      <ChatGptSubscriptionConnectDialog workspaceId={workspaceId} open={open} onOpenChange={setOpen} />
    </>
  );
}
