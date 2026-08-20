'use client';

import { SparkleIcon as Sparkles } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/marketing/button';
import { TemplateSessionInstallDialog } from './template-session-install-dialog';

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
        <Sparkles weight="duotone" className="size-4" />
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
