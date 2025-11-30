import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { referralsApi, ReferralCodeResponse, ReferralStats, ReferralListResponse, ValidateReferralCodeResponse, ReferralEmailResponse } from '@/lib/api/referrals';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

export const REFERRALS_QUERY_KEYS = {
  code: ['referrals', 'code'] as const,
  stats: ['referrals', 'stats'] as const,
  list: (limit: number, offset: number) => ['referrals', 'list', limit, offset] as const,
};

export function useReferralCode() {
  return useQuery({
    queryKey: REFERRALS_QUERY_KEYS.code,
    queryFn: () => referralsApi.getReferralCode(),
    staleTime: Infinity,
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
      toast.success(t('codeRefreshed'));
    },
    onError: () => {
      toast.error(t('refreshFailed'));
    },
  });
}

export function useReferralStats() {
  return useQuery({
    queryKey: REFERRALS_QUERY_KEYS.stats,
    queryFn: () => referralsApi.getReferralStats(),
    refetchInterval: 30000,
  });
}

export function useUserReferrals(limit = 50, offset = 0) {
  return useQuery({
    queryKey: REFERRALS_QUERY_KEYS.list(limit, offset),
    queryFn: () => referralsApi.getUserReferrals(limit, offset),
    refetchInterval: 30000,
  });
}

export function useValidateReferralCode() {
  return useMutation({
    mutationFn: (code: string) => referralsApi.validateReferralCode(code),
    onError: (error) => {
      toast.error('Failed to validate referral code');
      console.error('Referral code validation error:', error);
    },
  });
}

export function useCopyReferralLink() {
  const { data: referralData } = useReferralCode();

  const copyToClipboard = async () => {
    if (!referralData?.referral_url) {
      toast.error('Referral link not available');
      return;
    }

    try {
      await navigator.clipboard.writeText(referralData.referral_url);
      toast.success('Referral link copied to clipboard!');
    } catch (error) {
      console.error('Failed to copy referral link:', error);
      toast.error('Failed to copy referral link');
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

