'use client';

/**
 * "Connect MCP": how to hand the Kortix CLI to an MCP client. `kortix mcp`
 * (apps/cli/src/mcp.ts) serves every CLI command as a stdio tool, so the whole
 * setup is install → sign in → register one command with the client.
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
import { useDeploymentCliInstallCommand } from '@/lib/use-deployment-cli-install-command';
import { ArrowSquareOutIcon, CheckIcon, CopyIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

const SERVER = { command: 'kortix', args: ['mcp'] };
const SERVER_JSON = JSON.stringify({ mcpServers: { kortix: SERVER } }, null, 2);
const CURSOR_INSTALL_URL = `cursor://anysphere.cursor-deeplink/mcp/install?name=kortix&config=${btoa(JSON.stringify(SERVER))}`;

/** Kortix Cloud signs in with the CLI default; any other deployment names its API. */
export function loginCommand(backendUrl: string | undefined): string {
  if (!backendUrl) return 'kortix login';
  const api = new URL(backendUrl);
  if (api.hostname === 'api.kortix.com') return 'kortix login';
  return `kortix login --host ${api.hostname} --api ${api.origin}`;
}

export function ConnectMcpModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('connectMcp');
  const installCommand = useDeploymentCliInstallCommand(getEnv().VERSION);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] space-y-5 overflow-y-auto">
          <Step n={1} title={t('install')}>
            <CommandBlock text={installCommand} />
          </Step>
          <Step n={2} title={t('signIn')} hint={t('signInHint')}>
            <CommandBlock text={loginCommand(getEnv().BACKEND_URL)} />
          </Step>
          <Step n={3} title={t('addToClient')}>
            <Tabs defaultValue="claude" className="space-y-3">
              <TabsListCompact>
                <TabsTriggerCompact value="claude">Claude Code</TabsTriggerCompact>
                <TabsTriggerCompact value="codex">Codex</TabsTriggerCompact>
                <TabsTriggerCompact value="cursor">Cursor</TabsTriggerCompact>
                <TabsTriggerCompact value="other">{t('other')}</TabsTriggerCompact>
              </TabsListCompact>
              <TabsContent value="claude">
                <CommandBlock text="claude mcp add --scope user kortix -- kortix mcp" />
              </TabsContent>
              <TabsContent value="codex">
                <CommandBlock text="codex mcp add kortix -- kortix mcp" />
              </TabsContent>
              <TabsContent value="cursor" className="space-y-3">
                <Button asChild size="sm" variant="secondary" className="gap-1.5">
                  <a href={CURSOR_INSTALL_URL}>
                    <ArrowSquareOutIcon className="size-3.5 shrink-0" />
                    {t('addToCursor')}
                  </a>
                </Button>
                <CommandBlock text={SERVER_JSON} />
              </TabsContent>
              <TabsContent value="other" className="space-y-3">
                <p className="text-muted-foreground text-xs">{t('otherHint')}</p>
                <CommandBlock text={SERVER_JSON} />
              </TabsContent>
            </Tabs>
          </Step>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <Link href="/docs/mcp" target="_blank">
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

function Step({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">
          <span className="text-muted-foreground tabular-nums">{n}.</span> {title}
        </h3>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function CommandBlock({ text }: { text: string }) {
  const t = useTranslations('connectMcp');
  const { copy, copied } = useCopy();
  return (
    <div className="bg-muted relative rounded-md border">
      <pre className="scrollbar-hide overflow-x-auto px-3 py-2.5 pr-10 font-mono text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => copy(text)}
        aria-label={t('copy')}
        className="absolute top-1 right-1 size-7"
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
