'use client';

import { Sparkles } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { TemplateSessionInstallDialog } from './template-session-install-dialog';

/** "Use this template" — opens a guided install *session* in the project, where an
 *  agent sets the automation up conversationally (via the marketplace
 *  install-session). The button is gated at the page level by KORTIX_TEMPLATES_ENABLED. */
export function UseTemplateButton({
  templateId,
  title,
  className,
  variant,
  size,
  label = 'Use this template',
}: {
  templateId: string;
  title?: string;
  className?: string;
  variant?: React.ComponentProps<typeof Button>['variant'];
  size?: React.ComponentProps<typeof Button>['size'];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className={className} variant={variant} size={size} onClick={() => setOpen(true)}>
        <Sparkles className="size-4" />
        {label}
      </Button>
      <TemplateSessionInstallDialog
        templateId={templateId}
        title={title}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
