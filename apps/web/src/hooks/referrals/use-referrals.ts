import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { referralsApi } from '@/lib/api/referrals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

export const REFERRALS_QUERY_KEYS = {
  code: ['referrals', 'code'] as const,
  stats: ['referrals', 'stats'] as const,
  list: (limit: number, offset: number) => ['referrals', 'list', limit, offset] as const,
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

export function useRefreshReferralCode() {
  const queryClient = useQueryClient();
  const t = useTranslations('settings.referrals');

  return useMutation({
    mutationFn: () => referralsApi.refreshReferralCode(),
    onSuccess: (data) => {
      queryClient.setQueryData(REFERRALS_QUERY_KEYS.code, data);
      queryClient.invalidateQueries({ queryKey: REFERRALS_QUERY_KEYS.stats });
      successToast(t('codeRefreshed'));
    },
    onError: () => {
      errorToast(t('refreshFailed'));
    },
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

export function useUserReferrals(limit = 50, offset = 0, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: REFERRALS_QUERY_KEYS.list(limit, offset),
    queryFn: () => referralsApi.getUserReferrals(limit, offset),
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: enabled ? 60000 : false, // Only poll when enabled
    enabled,
  });
}

export function useValidateReferralCode() {
  return useMutation({
    mutationFn: (code: string) => referralsApi.validateReferralCode(code),
    onError: (error) => {
      errorToast('Failed to validate referral code');
      console.error('Referral code validation error:', error);
    },
  });
}

export function useCopyReferralLink() {
  const { data: referralData } = useReferralCode();

  const copyToClipboard = async () => {
    if (!referralData?.referral_url) {
      errorToast('Referral link not available');
      return;
    }

    try {
      await navigator.clipboard.writeText(referralData.referral_url);
      successToast('Referral link copied to clipboard!');
    } catch (error) {
      console.error('Failed to copy referral link:', error);
      errorToast('Failed to copy referral link');
    }
  };

  return { copyToClipboard, referralUrl: referralData?.referral_url };
}

export function useSendReferralEmails() {
  const t = useTranslations('settings.referrals');

  return useMutation({
    mutationFn: (emails: string[]) => referralsApi.sendReferralEmails(emails),
    onSuccess: (data) => {
      if (data.success_count && data.total_count) {
        if (data.success_count === data.total_count) {
          successToast(
            `Successfully sent ${data.success_count} ${data.success_count === 1 ? 'invitation' : 'invitations'}!`,
          );
        } else {
          warningToast(`Sent ${data.success_count} out of ${data.total_count} invitations`);
        }
      } else {
        successToast(t('emailSent'));
      }
    },
    onError: (error: any) => {
      const errorMessage = error?.message || 'Failed to send referral emails';
      errorToast(errorMessage);
      console.error('Referral email error:', error);
    },
  });
}
