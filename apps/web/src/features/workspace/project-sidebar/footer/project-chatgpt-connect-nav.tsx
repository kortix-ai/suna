'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useCallback, useState } from 'react';

import {
  ChatGptSubscriptionConnectDialog,
  useShowChatGptConnectPrompt,
} from '@/components/projects/chatgpt-subscription-connect';
import Hint from '@/components/ui/hint';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { OpenAI } from '@/features/icon/icons/open-ai';
import { useIsMobile } from '@/hooks/utils';

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
  const t = useTranslations('sidebar');
  const { show } = useShowChatGptConnectPrompt(projectId);
  const { open, setOpen, openDialog } = useChatGptConnectDialog(projectId);

  if (!show) return null;

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={openDialog}
          className="group/customize-button text-sidebar-foreground relative flex items-center justify-start"
        >
          <OpenAI className="text-foreground" />
          {t('connectGpt')}
        </SidebarMenuButton>
      </SidebarMenuItem>
      <ChatGptSubscriptionConnectDialog projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ProjectChatGptConnectRailItem({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const { show } = useShowChatGptConnectPrompt(projectId);
  const { open, setOpen, openDialog } = useChatGptConnectDialog(projectId);

  if (!show) return null;

  return (
    <>
      <Hint label={t('connectGpt')}>
        <SidebarMenuButton type="button" aria-label={t('connectGpt')} onClick={openDialog}>
          <OpenAI className="text-foreground size-4.5!" />
        </SidebarMenuButton>
      </Hint>
      <ChatGptSubscriptionConnectDialog projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  );
}
