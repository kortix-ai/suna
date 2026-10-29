'use client';

import { ArrowRightIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { TemplateSessionInstallDialog } from './template-session-install-dialog';

/** "Use this template": the marketing button (the navbar's Projects look) at
 *  the in-page size, with the trailing arrow the landing CTAs carry, opening
 *  the install dialog. */
export function UseTemplateButton({
  templateId,
  title,
  className,
  label = 'Use this template',
}: {
  templateId: string;
  title?: string;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MarketingButton size="md" className={className} onClick={() => setOpen(true)}>
        {label}
        <ArrowRightIcon weight="fill" aria-hidden />
      </MarketingButton>
      <TemplateSessionInstallDialog
        templateId={templateId}
        title={title}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
