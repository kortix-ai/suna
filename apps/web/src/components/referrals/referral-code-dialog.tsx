'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslations } from 'next-intl';

interface ReferralCodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  referralCode?: string;
  onCodeChange?: (code: string) => void;
}

export function ReferralCodeDialog({ open, onOpenChange, referralCode = '', onCodeChange }: ReferralCodeDialogProps) {
  const t = useTranslations('settings.referrals');
  const tCommon = useTranslations('common');
  const [code, setCode] = React.useState(referralCode);

  React.useEffect(() => {
    setCode(referralCode);
  }, [referralCode]);

  const handleSave = () => {
    if (onCodeChange) {
      onCodeChange(code.toUpperCase());
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[320px] p-0 gap-0 overflow-hidden border-foreground/[0.07] bg-background/90 backdrop-blur-2xl">
        <div className="p-5">
          {/* Header */}
          <div className="mb-4">
            <DialogTitle className="text-sm font-medium text-foreground/85 tracking-tight">
              {t('yourReferralCode')}
            </DialogTitle>
            <p className="text-xs text-foreground/40 mt-0.5">
              {t('enterCodeDescription')}
            </p>
          </div>

          {/* Code Input */}
          <Input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('enterCode')}
            maxLength={8}
            className="font-mono text-center text-[15px] font-medium tracking-widest mb-4"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          />

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 text-[13px] text-foreground/40 hover:text-foreground/70 "
              onClick={() => onOpenChange(false)}
            >
              {tCommon('cancel')}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="flex-1 text-[13px]"
              onClick={handleSave}
            >
              {tCommon('save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
