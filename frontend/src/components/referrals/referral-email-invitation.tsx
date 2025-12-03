'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Mail, X, Loader2, Check } from 'lucide-react';
import { useSendReferralEmails } from '@/hooks/referrals/use-referrals';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface ReferralEmailProps {
  className?: string;
}

interface EmailStatus {
  email: string;
  status: 'pending' | 'sending' | 'sent' | 'error';
}

const MAX_EMAILS = 3;

export function ReferralEmailInvitation({ className }: ReferralEmailProps) {
  const t = useTranslations('settings.referrals');
  const sendEmailsMutation = useSendReferralEmails();
  
  const [inputValue, setInputValue] = React.useState('');
  const [emails, setEmails] = React.useState<EmailStatus[]>([]);
  const [isSending, setIsSending] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const isValidEmail = (email: string) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const addEmail = (email: string) => {
    const trimmedEmail = email.trim().toLowerCase();
    
    if (!trimmedEmail) return;

    if (emails.length >= MAX_EMAILS) {
      toast.error(`Maximum ${MAX_EMAILS} emails allowed`);
      return;
    }

    if (!isValidEmail(trimmedEmail)) {
      toast.error('Please enter a valid email address');
      return;
    }

    if (emails.some(e => e.email === trimmedEmail)) {
      toast.error('Email already added');
      return;
    }

    setEmails([...emails, { email: trimmedEmail, status: 'pending' }]);
    setInputValue('');
  };

  const removeEmail = (emailToRemove: string) => {
    setEmails(emails.filter(e => e.email !== emailToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      addEmail(inputValue);
    } else if (e.key === 'Backspace' && !inputValue && emails.length > 0) {
      removeEmail(emails[emails.length - 1].email);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData('text');
    const pastedEmails = pastedText.split(/[\s,;]+/).filter(Boolean);
    
    pastedEmails.forEach(email => addEmail(email));
  };

  const sendAllEmails = async () => {
    const unsent = emails.filter(e => e.status === 'pending' || e.status === 'error');
    
    if (unsent.length === 0) return;

    const emailsToSend = unsent.map(e => e.email);
    
    setIsSending(true);
    emailsToSend.forEach(email => {
      setEmails(prev => 
        prev.map(e => e.email === email ? { ...e, status: 'sending' as const } : e)
      );
    });

    try {
      const result = await sendEmailsMutation.mutateAsync(emailsToSend);
      
      if (result.results) {
        result.results.forEach(r => {
          setEmails(prev => 
            prev.map(e => e.email === r.email 
              ? { ...e, status: r.success ? 'sent' as const : 'error' as const } 
              : e
            )
          );
        });
      } else {
        emailsToSend.forEach(email => {
          setEmails(prev => 
            prev.map(e => e.email === email ? { ...e, status: 'sent' as const } : e)
          );
        });
      }
    } catch (error) {
      emailsToSend.forEach(email => {
        setEmails(prev => 
          prev.map(e => e.email === email ? { ...e, status: 'error' as const } : e)
        );
      });
    } finally {
      setIsSending(false);
    }
  };

  const hasUnsentEmails = emails.some(e => e.status === 'pending' || e.status === 'error');

  return (
    <div className={cn('space-y-2', className)}>
      <label className="text-xs sm:text-sm font-medium text-foreground block">
        {t('inviteByEmail')}
      </label>

      <div className="flex gap-2">
        <div
          className={cn(
            'min-h-[44px] flex-1 rounded-2xl border bg-card px-3 py-2 text-sm transition-[color,box-shadow]',
            'focus-within:outline-none focus-within:ring-2 focus-within:ring-primary/50',
            'flex flex-wrap gap-1.5 items-center cursor-text'
          )}
          onClick={() => inputRef.current?.focus()}
        >
          {emails.map(({ email, status }) => (
            <Badge
              key={email}
              variant={status === 'sent' ? 'highlight' : status === 'error' ? 'destructive' : 'secondary'}
              className={cn(
                'pl-2 pr-1 py-1 gap-1.5 text-xs font-normal',
                status === 'sending' && 'opacity-60'
              )}
            >
              {status === 'sending' && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              {status === 'sent' && (
                <Check className="h-3 w-3" />
              )}
              <span className="max-w-[200px] truncate">{email}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeEmail(email);
                }}
                disabled={status === 'sending'}
                className="hover:bg-black/10 dark:hover:bg-white/10 rounded-full p-0.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          
          <input
            ref={inputRef}
            type="email"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={() => {
              if (inputValue.trim()) {
                addEmail(inputValue);
              }
            }}
            placeholder={emails.length === 0 ? t('emailPlaceholder') : ''}
            disabled={emails.length >= MAX_EMAILS}
            className="flex-1 min-w-[120px] bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
        </div>

        <Button
          variant="default"
          size="default"
          className="h-11 px-4 flex-shrink-0"
          onClick={sendAllEmails}
          disabled={!hasUnsentEmails || isSending}
        >
          {isSending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Mail className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">
            {isSending ? t('sending') : t('send')}
          </span>
        </Button>
      </div>

      {emails.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span>
            {emails.length} / {MAX_EMAILS} {t('emailsAdded')}
          </span>
          <span>
            {emails.filter(e => e.status === 'sent').length} {t('sent')}
          </span>
        </div>
      )}
    </div>
  );
}