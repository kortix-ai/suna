'use client';

/**
 * SupportDialog — the one "how do I get help?" surface.
 *
 * Direct support — support@kortix.ai (copy-to-clipboard) + a link to the docs.
 *
 * Triggered from the user menu's "Support" row.
 */

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Copy } from 'lucide-react';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

const SUPPORT_EMAIL = 'support@kortix.ai';

export function SupportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();

  const copyEmail = useCallback(async (email: string) => {
    try {
      await navigator.clipboard.writeText(email);
      toast.success(`${email} copied`);
    } catch {
      window.location.href = `mailto:${email}`;
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg gap-0 overflow-hidden rounded-3xl p-0">
        <div className="px-7 pt-7 pb-5">
          <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
            Get help
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            We&rsquo;re here when you need us.
          </DialogDescription>
        </div>

        <div className="border-t border-border/60 px-7 py-6">
          <SectionLabel>Direct support</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            For bug reports, account issues, and general questions, email
            the team. We reply within one business day.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => copyEmail(SUPPORT_EMAIL)}
              className="gap-1.5"
            >
              <Copy />
              {SUPPORT_EMAIL}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
                router.push('/docs');
              }}
              className="gap-1.5"
            >
              <BookOpen />
              Read the docs
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
      {children}
    </div>
  );
}
