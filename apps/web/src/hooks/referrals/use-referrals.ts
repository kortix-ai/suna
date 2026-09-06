import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { copyToClipboard } from '@/lib/utils/clipboard';
import {
  getReferralCode,
  getReferralStats,
  listReferrals,
  refreshReferralCode,
  sendReferralEmails,
  validateReferralCode,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';

export const REFERRALS_QUERY_KEYS = {
  code: ['referrals', 'code'] as const,
  stats: ['referrals', 'stats'] as const,
  list: (limit: number, offset: number) => ['referrals', 'list', limit, offset] as const,
};

export function useReferralCode(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: REFERRALS_QUERY_KEYS.code,
    queryFn: getReferralCode,
    staleTime: Infinity,
    enabled,
  });
}

export function useRefreshReferralCode() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const t = useTranslations('settings.referrals');

  return useMutation({
    mutationFn: refreshReferralCode,
    onSuccess: (data) => {
      queryClient.setQueryData(REFERRALS_QUERY_KEYS.code, data);
      queryClient.invalidateQueries({ queryKey: REFERRALS_QUERY_KEYS.stats });
      successToast(tI18nComplete('text15be258f884e'));
    },
    onError: () => {
      errorToast(tI18nComplete('text9a076574cb80'));
    },
  });
}

export function useReferralStats(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: REFERRALS_QUERY_KEYS.stats,
    queryFn: getReferralStats,
    staleTime: 5 * 60 * 1000, // 5 minutes - data doesn't change frequently
    refetchInterval: enabled ? 60000 : false, // Only poll when enabled, and less aggressively (1 min)
    enabled,
  });
}

export function useUserReferrals(limit = 50, offset = 0, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: REFERRALS_QUERY_KEYS.list(limit, offset),
    queryFn: () => listReferrals({ limit, offset }),
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: enabled ? 60000 : false, // Only poll when enabled
    enabled,
  });
}

export function useValidateReferralCode() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return useMutation({
    mutationFn: validateReferralCode,
    onError: (error) => {
      errorToast(tI18nComplete.raw('textdd430cfb3b0a'));
      console.error('Referral code validation error:', error);
    },
  });
}

export function useCopyReferralLink() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { data: referralData } = useReferralCode();

  const copyLink = async () => {
    if (!referralData?.referral_url) {
      errorToast(tI18nComplete.raw('text700e7474f9a9'));
      return;
    }

    if (await copyToClipboard(referralData.referral_url)) {
      successToast(tI18nComplete.raw('texta9c084ffb5c8'));
    } else {
      errorToast(tI18nComplete.raw('text0ab1250f5d8a'));
    }
  };

  return { copyToClipboard: copyLink, referralUrl: referralData?.referral_url };
}

export function useSendReferralEmails() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('settings.referrals');

  return useMutation({
    mutationFn: sendReferralEmails,
    onSuccess: (data) => {
      if (data.success_count && data.total_count) {
        if (data.success_count === data.total_count) {
          successToast(
            tI18nComplete('textd7a95595744f', {
              value0: data.success_count,
              value1:
                data.success_count === 1
                  ? tI18nComplete.raw('texta3013c082c75')
                  : tI18nComplete.raw('text33cd5e40bb5f'),
            }),
          );
        } else {
          warningToast(
            tI18nComplete('text12cddd9b2730', {
              value0: data.success_count,
              value1: data.total_count,
            }),
          );
        }
      } else {
        successToast(tI18nComplete('textd9016ff54bb6'));
      }
    },
    onError: (error: any) => {
      const errorMessage = error?.message || 'Failed to send referral emails';
      errorToast(errorMessage);
      console.error('Referral email error:', error);
    },
  });
}
