'use client';

import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { CommandBlock, ConnectMcpModal, mcpUrl } from '@/features/layout/connect-mcp-modal';
import { useTranslations } from '@/i18n/use-translations';
import { getEnv } from '@/lib/env-config';

/** The Capture tools of the Kortix MCP server; each one is a route under `/v1/accounts/:id/capture`. */
const CAPTURE_TOOLS = [
  'capture_accounts',
  'capture_search',
  'capture_timeline',
  'capture_frame',
  'capture_episodes',
  'capture_episode',
  'capture_workflows',
  'capture_workflow',
  'capture_export',
] as const;

/**
 * "Use Kortix Capture in an agent": Capture has no chat of its own. An agent
 * reads its data through the Kortix MCP server, with the same scoping and
 * audit as this area. The modal shows the URL, the Capture tools and an
 * example question, and opens the general "Connect MCP" steps per client.
 */
export function CaptureAgentModal({
  open,
  onOpenChange,
  accountName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountName: string;
}) {
  const t = useTranslations('capture.agent');
  const [connectOpen, setConnectOpen] = useState(false);
  const url = mcpUrl(getEnv().BACKEND_URL);
  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange}>
        <ModalContent className="lg:max-w-lg">
          <ModalHeader>
            <ModalTitle>{t('title')}</ModalTitle>
            <ModalDescription>{t('description')}</ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[70vh] space-y-5 overflow-y-auto">
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('step1')}</h3>
              <CommandBlock text={url} />
              <p className="text-muted-foreground text-xs text-pretty">{t('step1Hint')}</p>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('step2')}</h3>
              <ul className="space-y-1.5">
                {CAPTURE_TOOLS.map((tool) => (
                  <li key={tool} className="grid grid-cols-[10rem_minmax(0,1fr)] gap-3 text-xs">
                    <code className="text-foreground font-mono">{tool}</code>
                    <span className="text-muted-foreground">{t(`tool.${tool}`)}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('step3')}</h3>
              <p className="bg-muted text-foreground rounded-md border px-3 py-2.5 text-sm">
                {t('example', { name: accountName })}
              </p>
              <p className="text-muted-foreground text-xs text-pretty">{t('scopeNote')}</p>
            </section>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button asChild variant="ghost" size="sm" className="gap-1.5">
              <Link href="/docs/capture" target="_blank">
                {t('docs')}
                <ArrowSquareOutIcon className="size-3.5 shrink-0" />
              </Link>
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onOpenChange(false);
                setConnectOpen(true);
              }}
            >
              {t('connect')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <ConnectMcpModal open={connectOpen} onOpenChange={setConnectOpen} />
    </>
  );
}
