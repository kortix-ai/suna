'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';

import {
  ChatGptSubscriptionConnectDialog,
  useShowChatGptConnectPrompt,
} from '@/components/projects/chatgpt-subscription-connect';
import Hint from '@/components/ui/hint';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { OpenAI } from '@/features/icon/icons/open-ai';
import { ChatGptAccountsDialog } from '@/features/providers/chatgpt-accounts-dialog';
import { useIsMobile } from '@/hooks/utils';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';

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

/**
 * With pooled provider secrets, ChatGPT is a per-member account: the legacy
 * dialog would connect ONE shared project login, which a plain member may not
 * write. Those projects open the member's own ChatGPT accounts instead.
 */
function ChatGptConnectDialog({ projectId, open, onOpenChange }: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const pooled = useFeatureFlag(projectId, 'pooled_provider_secrets');
  const project = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  if (pooled.enabled && isLlmGatewayEnabled(project.data?.project)) {
    return <ChatGptAccountsDialog projectId={projectId} open={open} onOpenChange={onOpenChange} />;
  }
  return <ChatGptSubscriptionConnectDialog projectId={projectId} open={open} onOpenChange={onOpenChange} />;
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
      <ChatGptConnectDialog projectId={projectId} open={open} onOpenChange={setOpen} />
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
      <ChatGptConnectDialog projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  );
}
