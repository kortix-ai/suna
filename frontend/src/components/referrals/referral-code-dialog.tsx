'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
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
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
        <div className="p-4 sm:p-6">
          {/* Logo & Header */}
          <div className="flex flex-col items-center text-center mb-4">
            <div className="mb-2 p-2 rounded-xl bg-muted/50">
              <KortixLogo size={24} variant="symbol" />
            </div>
            <DialogTitle className="text-base sm:text-lg font-semibold">
              {t('yourReferralCode')}
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {t('enterCodeDescription')}
            </p>
          </div>

          {/* Code Input */}
          <div className="mb-4">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder={t('enterCode')}
              maxLength={8}
              className="font-mono text-center text-base font-semibold"
              autoFocus
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              className="flex-1"
              onClick={() => onOpenChange(false)}
            >
              {tCommon('cancel')}
            </Button>
            <Button
              variant="default"
              className="flex-1"
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
