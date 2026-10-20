'use client';

import Link from '@/components/site-link';
import { Button } from '@/components/ui/button';
import { connectorsHref } from '@/features/workspace/capabilities/connectors/connector-routes';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { successToast, warningToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { useProjectApps } from '@kortix/sdk/react';
import { useState } from 'react';

/** A slug from a display name: lowercase letters, numbers and single hyphens, at most 63. */
export function slugFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '') || 'app';
}

/**
 * Add an App hosted elsewhere by its URL: the grid lists it and the detail
 * frames it, so a third-party tool sits in Kortix beside the Apps it runs.
 */
export function AddExternalAppDialog({
  projectId,
  open,
  onOpenChange,
  onAdded,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (appId: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('externalApp');
  const apps = useProjectApps(projectId);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const host = (() => {
    try {
      const parsed = new URL(url.trim());
      return parsed.protocol === 'https:' && parsed.hostname.includes('.') ? parsed.hostname.replace(/^www\./, '') : '';
    } catch {
      return '';
    }
  })();
  // The name defaults to the site's host: a URL alone is enough.
  const appName = name.trim() || host;
  const ready = !!host && !apps.create.isPending;

  const submit = async () => {
    if (!ready) return;
    try {
      const app = await apps.create.mutateAsync({ slug: slugFromName(appName), name: appName, external_url: url.trim() });
      const notFramed = app.warnings?.find((warning) => warning.code === 'app_external_not_frameable');
      if (notFramed) warningToast(notFramed.message);
      else successToast(tI18nComplete('text08e6480e9b78', { value0: app.name }));
      setName('');
      setUrl('');
      onOpenChange(false);
      onAdded(app.app_id);
    } catch {
      // Failure is already toasted by the query client's global mutations.onError.
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('text68cf13547e38')}</ModalTitle>
          <ModalDescription>{tI18nComplete.raw('text46bc646c9bfe')}</ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <ModalBody>
            <p className="text-sm text-muted-foreground">
              {t.rich('connectorGuidance', {
                connectors: (chunks) => (
                  <Link href={connectorsHref(projectId)} className="text-foreground underline" onClick={() => onOpenChange(false)}>
                    {chunks}
                  </Link>
                ),
              })}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="external-app-url">{tI18nComplete.raw('texte7a241debad5')}</Label>
              <Input
                id="external-app-url"
                type="url"
                inputMode="url"
                autoFocus
                placeholder="https://"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="external-app-name">{tI18nComplete.raw('textdcd1d5223f73')}</Label>
              <Input id="external-app-name" value={name} placeholder={host} maxLength={200} onChange={(event) => setName(event.target.value)} />
            </div>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" className="gap-1.5" disabled={!ready}>
              {apps.create.isPending ? <Loading /> : null}
              {tI18nComplete.raw('text9fd728c66c9a')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
