'use client';

/**
 * "Connect MCP": the hosted MCP URL and how to add it to a client. One URL per
 * person, like the `kortix` CLI: it reaches every project the signed-in user
 * can open. The client signs in with OAuth on first use (apps/api/src/mcp), so
 * there is nothing to install.
 *
 * Same split frame as "Connect your computer" (`features/tunnel/computer-connect.tsx`):
 * the Beams art with the client marks on the left, one row per client with its
 * own one-click action on the right.
 */

import { ArrowUpRightIcon, LinkSimpleIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ComponentType } from 'react';

import { Button } from '@/components/ui/button';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '@/components/ui/modal';
import { BeamsShader } from '@/components/ui/paper-wallpaper-shaders';
import { Claude } from '@/features/icon/icons/claude';
import { ClaudeCode } from '@/features/icon/icons/claude-code';
import { Codex } from '@/features/icon/icons/codex';
import { Cursor } from '@/features/icon/icons/cursor';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { useCopy } from '@/hooks/use-copy';
import { useTranslations } from '@/i18n/use-translations';
import { getEnv } from '@/lib/env-config';
import { cn } from '@/lib/utils';

/** The MCP endpoint: `<api origin>/v1/mcp`. */
export function mcpUrl(backendUrl: string | undefined): string {
  const base = (backendUrl || 'https://api.kortix.com/v1').replace(/\/+$/, '');
  return `${base.endsWith('/v1') ? base : `${base}/v1`}/mcp`;
}

export function cursorInstallUrl(url: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=kortix&config=${btoa(JSON.stringify({ url }))}`;
}

type ClientId = 'claude' | 'claude-code' | 'cursor' | 'codex' | 'other';

interface Client {
  id: ClientId;
  /** Product names are identifiers, not UI copy. `null`: the translated "Any MCP client". */
  name: string | null;
  Logo: ComponentType<{ className?: string }>;
  /** `url`: copies the URL. `command`: copies `text(url)`. `link`: opens `href(url)`. */
  action:
  | { kind: 'url' }
  | { kind: 'command'; text: (url: string) => string }
  | { kind: 'link'; href: (url: string) => string };
}

const OtherLogo = ({ className }: { className?: string }) => (
  <LinkSimpleIcon className={cn('text-muted-foreground', className)} />
);

const CLIENTS: readonly Client[] = [
  { id: 'claude', name: 'Claude', Logo: Claude, action: { kind: 'url' } },
  {
    id: 'claude-code',
    name: 'Claude Code',
    Logo: ClaudeCode,
    action: { kind: 'command', text: (url) => `claude mcp add --transport http kortix ${url}` },
  },
  { id: 'cursor', name: 'Cursor', Logo: Cursor, action: { kind: 'link', href: cursorInstallUrl } },
  {
    id: 'codex',
    name: 'Codex',
    Logo: Codex,
    action: {
      kind: 'command',
      text: (url) => `codex mcp add kortix --url ${url}\ncodex mcp login kortix`,
    },
  },
  { id: 'other', name: null, Logo: OtherLogo, action: { kind: 'url' } },
];

/** The four named clients, drawn on the art. */
const ART_CLIENTS = CLIENTS.filter((client) => client.id !== 'other');

export function ConnectMcpModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('connectMcp');
  const url = mcpUrl(getEnv().BACKEND_URL);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        className="space-y-0 lg:max-w-3xl"
        closeClassName="max-sm:bg-background border-0 overflow-hidden"
      >
        {/* Art beside the content from `sm`; a short banner above it on a phone.
            The art is dark in both themes, so its tokens resolve under `dark`.
            It rounds its own outer corners: the modal is a scroll container,
            and its corner clip does not reach the shader's WebGL canvas. */}
        <div className="grid sm:grid-cols-5 lg:min-h-128">
          <div
            aria-hidden="true"
            className="dark bg-background relative isolate flex h-48 items-center justify-center overflow-hidden rounded-t-xl border-b sm:col-span-2 sm:h-auto sm:rounded-tr-none sm:border-r sm:border-b-0 lg:rounded-bl-xl"
          >
            <BeamsShader />
            <div className="relative grid grid-cols-4 gap-2.5 sm:grid-cols-2">
              {ART_CLIENTS.map(({ id, Logo }) => (
                // `bg-foreground` is white under the art's `dark` scope: the marks carry their
                // own brand colors (Codex brings its own white tile).
                <span
                  key={id}
                  className="bg-foreground flex size-16 items-center justify-center rounded-xl shadow-lg"
                >
                  <Logo className="size-8" />
                </span>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-5 p-5 sm:col-span-3 lg:p-8">
            <header className="space-y-1.5 pr-10">
              <ModalTitle className="text-lg font-medium text-balance">{t('title')}</ModalTitle>
              <ModalDescription className="text-pretty">{t('description')}</ModalDescription>
            </header>
            <ul className="divide-border divide-y">
              {CLIENTS.map((client) => (
                <li key={client.id} className="flex items-center gap-3 py-2.5">
                  <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-sm">
                    <client.Logo className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-sm font-medium">{client.name ?? t('anyClient')}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {t(`via.${client.id}`)}
                    </p>
                  </div>
                  <ClientAction client={client} url={url} />
                </li>
              ))}
            </ul>
            {/* Actions sit on the bottom edge, level with the foot of the art. */}
            <footer className="mt-auto flex items-center justify-between pt-2">
              <Button asChild variant="ghost" size="sm" className="text-muted-foreground gap-1">
                <Link href="/docs/connect/mcp" target="_blank">
                  {t('docs')}
                  <ArrowUpRightIcon className="size-3.5 shrink-0" />
                </Link>
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t('done')}
              </Button>
            </footer>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
}

// The secondary fill sits close to the row; a ring on hover marks the target.
const ACTION_CLASS = 'hover:border-ring hover:border hover:ring-ring/15 hover:ring-2 hit-area-debug hit-area-y-3 hit-area-l-3 shrink-0';

/** The client's own one-click action: copy the URL or its command, or open its deep link. */
function ClientAction({ client, url }: { client: Client; url: string }) {
  const t = useTranslations('connectMcp');
  // The button itself confirms the copy; no toast.
  const { copy, copied } = useCopy({ toast: false });
  const { action } = client;
  if (action.kind === 'link') {
    return (
      <Button asChild size="sm" variant="secondary" className={ACTION_CLASS}>
        <a href={action.href(url)}>{t('add')}</a>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className={cn(ACTION_CLASS, 'gap-1.5')}
      onClick={() => copy(action.kind === 'url' ? url : action.text(url))}
    >
      {copied ? <SolidCheckIcon className="size-3.5" /> : null}
      {copied ? t('copied') : action.kind === 'url' ? t('copyUrl') : t('copy')}
    </Button>
  );
}
