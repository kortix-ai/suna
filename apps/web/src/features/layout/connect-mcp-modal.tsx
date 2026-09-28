'use client';

/**
 * "Connect MCP": the project's hosted MCP URL and how to add it to a client.
 * The client signs in with OAuth on first use (apps/api/src/mcp), so there is
 * nothing to install. Shown only when the project's `mcp` feature flag is on.
 */

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
import { Tabs, TabsContent, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { useCopy } from '@/hooks/use-copy';
import { useTranslations } from '@/i18n/use-translations';
import { getEnv } from '@/lib/env-config';
import { ArrowSquareOutIcon, CheckIcon, CopyIcon } from '@phosphor-icons/react';
import Link from 'next/link';

/** The project's MCP endpoint: `<api origin>/v1/projects/<id>/mcp`. */
export function mcpUrl(backendUrl: string | undefined, projectId: string): string {
  const base = (backendUrl || 'https://api.kortix.com/v1').replace(/\/+$/, '');
  return `${base.endsWith('/v1') ? base : `${base}/v1`}/projects/${projectId}/mcp`;
}

export function cursorInstallUrl(url: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=kortix&config=${btoa(JSON.stringify({ url }))}`;
}

const claudeCodeCommand = (url: string) => `claude mcp add --transport http kortix ${url}`;
const codexCommands = (url: string) => `codex mcp add kortix --url ${url}\ncodex mcp login kortix`;

// Client and product names are identifiers, not UI copy.
const TABS = [
  { id: 'claude', name: 'Claude' },
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'codex', name: 'Codex' },
] as const;

export function ConnectMcpModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('connectMcp');
  const url = mcpUrl(getEnv().BACKEND_URL, projectId);
  const json = JSON.stringify({ mcpServers: { kortix: { url } } }, null, 2);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] space-y-5 overflow-y-auto">
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('urlLabel')}</h3>
            <CommandBlock text={url} />
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('addToClient')}</h3>
            <Tabs defaultValue="claude" className="space-y-3">
              <TabsListCompact>
                {TABS.map((tab) => (
                  <TabsTriggerCompact key={tab.id} value={tab.id}>
                    {tab.name}
                  </TabsTriggerCompact>
                ))}
                <TabsTriggerCompact value="other">{t('other')}</TabsTriggerCompact>
              </TabsListCompact>
              <TabsContent value="claude">
                <p className="text-muted-foreground text-xs">{t('claudeSteps')}</p>
              </TabsContent>
              <TabsContent value="claude-code" className="space-y-2">
                <CommandBlock text={claudeCodeCommand(url)} />
                <p className="text-muted-foreground text-xs">{t('claudeCodeHint')}</p>
              </TabsContent>
              <TabsContent value="cursor" className="space-y-3">
                <Button asChild size="sm" variant="secondary" className="gap-1.5">
                  <a href={cursorInstallUrl(url)}>
                    <ArrowSquareOutIcon className="size-3.5 shrink-0" />
                    {t('addToCursor')}
                  </a>
                </Button>
                <p className="text-muted-foreground text-xs">{t('signInOnFirstUse')}</p>
              </TabsContent>
              <TabsContent value="codex" className="space-y-2">
                <CommandBlock text={codexCommands(url)} />
              </TabsContent>
              <TabsContent value="other" className="space-y-2">
                <p className="text-muted-foreground text-xs">{t('otherHint')}</p>
                <CommandBlock text={json} />
              </TabsContent>
            </Tabs>
          </section>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <Link href="/docs/feature-flags/mcp" target="_blank">
              {t('docs')}
              <ArrowSquareOutIcon className="size-3.5 shrink-0" />
            </Link>
          </Button>
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            {t('done')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function CommandBlock({ text }: { text: string }) {
  const t = useTranslations('connectMcp');
  const { copy, copied } = useCopy();
  return (
    <div className="bg-muted flex items-start rounded-md border">
      <pre className="scrollbar-hide min-w-0 flex-1 overflow-x-auto py-2.5 pl-3 font-mono text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => copy(text)}
        aria-label={t('copy')}
        className="m-1 size-7 shrink-0"
      >
        {copied ? (
          <CheckIcon className="text-kortix-green size-3.5" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </Button>
    </div>
  );
}
