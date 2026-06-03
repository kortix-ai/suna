import { useQuery, useMutation } from '@tanstack/react-query';
import { referralsApi } from '@/lib/api/referrals';
import { toast } from '@/lib/toast';
import { useTranslations } from 'next-intl';

const REFERRALS_QUERY_KEYS = {
  code: ['referrals', 'code'] as const,
  stats: ['referrals', 'stats'] as const,
};

export function useReferralCode(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: REFERRALS_QUERY_KEYS.code,
    queryFn: () => referralsApi.getReferralCode(),
    staleTime: Infinity,
    enabled,
  });
}

export function useReferralStats(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: REFERRALS_QUERY_KEYS.stats,
    queryFn: () => referralsApi.getReferralStats(),
    staleTime: 5 * 60 * 1000, // 5 minutes - data doesn't change frequently
    refetchInterval: enabled ? 60000 : false, // Only poll when enabled, and less aggressively (1 min)
    enabled,
  });
}

export function useSendReferralEmails() {
  const t = useTranslations('settings.referrals');
  
  return useMutation({
    mutationFn: (emails: string[]) => referralsApi.sendReferralEmails(emails),
    onSuccess: (data) => {
      if (data.success_count && data.total_count) {
        if (data.success_count === data.total_count) {
          toast.success(`Successfully sent ${data.success_count} ${data.success_count === 1 ? 'invitation' : 'invitations'}!`);
        } else {
          toast.warning(`Sent ${data.success_count} out of ${data.total_count} invitations`);
        }
      } else {
        toast.success(t('emailSent'));
      }
    },
    onError: (error: any) => {
      const errorMessage = error?.message || 'Failed to send referral emails';
      toast.error(errorMessage);
      console.error('Referral email error:', error);
    },
  });
}
