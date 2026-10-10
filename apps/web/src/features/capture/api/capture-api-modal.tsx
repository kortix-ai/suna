'use client';

import { ArrowSquareOutIcon, CheckIcon, CopyIcon } from '@phosphor-icons/react';
import Link from 'next/link';

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
import { useCopy } from '@/hooks/use-copy';
import { useTranslations } from '@/i18n/use-translations';
import { getEnv } from '@/lib/env-config';

/** `<api origin>/v1/accounts/<accountId>/capture`. */
export function captureApiBase(backendUrl: string | undefined, accountId: string): string {
  const base = (backendUrl || 'https://api.kortix.com/v1').replace(/\/+$/, '');
  return `${base.endsWith('/v1') ? base : `${base}/v1`}/accounts/${accountId}/capture`;
}

/** The data endpoints, relative to the base URL. Each one is a REST route with the same scoping and audit as this area. */
const ENDPOINTS = [
  { id: 'account', routes: ['GET /'] },
  { id: 'search', routes: ['GET /search?q='] },
  { id: 'timeline', routes: ['GET /timeline', 'GET /timeline/items'] },
  { id: 'frames', routes: ['GET /frames/{frame_id}', 'GET /chunks/{chunk_id}/media'] },
  { id: 'episodes', routes: ['GET /episodes', 'GET /episodes/{episode_id}'] },
  { id: 'workflows', routes: ['GET /workflows', 'GET /workflows/{workflow_id}'] },
  { id: 'exports', routes: ['POST /exports', 'GET /exports/{export_id}'] },
] as const;

/**
 * "Kortix Capture API": Capture's data over its own REST API, for scripts,
 * agents or anything else. Base URL, a Kortix API key, the data endpoints, one
 * example, and who sees what. Opened from Overview and Devices.
 */
export function CaptureApiModal({
  open,
  onOpenChange,
  accountId,
  own,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  /** A member: the API returns only their own recordings. */
  own: boolean;
}) {
  const t = useTranslations('capture.api');
  const base = captureApiBase(getEnv().BACKEND_URL, accountId);
  const example = `curl -H "Authorization: Bearer $KORTIX_API_KEY" \\\n  "${base}/search?q=invoice"`;
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-xl">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] space-y-5 overflow-y-auto">
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('baseUrl')}</h3>
            <CommandBlock text={base} />
          </section>
          <section className="space-y-1">
            <h3 className="text-sm font-medium">{t('auth')}</h3>
            <p className="text-muted-foreground text-xs text-pretty">
              {t('authBody')}{' '}
              <Link
                href="/settings/tokens"
                className="text-foreground underline-offset-4 hover:underline"
              >
                {t('createKey')}
              </Link>
            </p>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('endpoints')}</h3>
            <ul className="space-y-2">
              {ENDPOINTS.map((endpoint) => (
                <li
                  key={endpoint.id}
                  className="grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[15rem_minmax(0,1fr)]"
                >
                  <span className="flex flex-col">
                    {endpoint.routes.map((route) => (
                      <code key={route} className="text-foreground font-mono whitespace-nowrap">
                        {route}
                      </code>
                    ))}
                  </span>
                  <span className="text-muted-foreground">{t(`endpoint.${endpoint.id}`)}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('example')}</h3>
            <CommandBlock text={example} />
          </section>
          <p className="text-muted-foreground text-xs text-pretty">
            {own ? t('scopeOwn') : t('scopeAll')}
          </p>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <Link href="/docs/capture#kortix-capture-api" target="_blank">
              {t('docs')}
              <ArrowSquareOutIcon className="size-3.5 shrink-0" />
            </Link>
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t('done')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** A copyable block of text: the base URL or the example request. */
function CommandBlock({ text }: { text: string }) {
  const t = useTranslations('connectMcp');
  const { copy, copied } = useCopy();
  return (
    <div className="bg-muted flex items-start rounded-md border">
      <pre className="scrollbar-hide min-w-0 flex-1 overflow-x-auto py-2.5 pl-3 font-mono text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
      <Button type="button" variant="ghost" size="icon" onClick={() => copy(text)} aria-label={t('copy')} className="m-1 size-7 shrink-0">
        {copied ? <CheckIcon className="text-kortix-green size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
