'use client';

import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';

export function SignInHelpDisclosure({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <Disclosure open={open} onOpenChange={setOpen} className="mt-3">
      <DisclosureTrigger>
        <Button
          type="button"
          variant="transparent"
          size="sm"
          aria-controls={contentId}
          className="text-muted-foreground hover:text-foreground -mx-2 -my-1 h-10 justify-start gap-1.5 px-2 transition-[color,transform] active:scale-[0.96]"
        >
          <span>Sign-in help</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3.5 transition-transform duration-200 ease-out',
              open && 'rotate-180',
            )}
          />
        </Button>
      </DisclosureTrigger>
      <DisclosureContent contentClassName="pt-1">
        <p
          id={contentId}
          className="border-border bg-muted/50 text-muted-foreground rounded-md border px-3 py-2 text-sm text-pretty"
        >
          Use your work email; if your company uses SSO, we&apos;ll route you automatically.
        </p>
      </DisclosureContent>
    </Disclosure>
  );
}
