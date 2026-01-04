import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { phoneVerificationService } from '@/lib/api/phone-verification';
import { useAuth } from '@/components/AuthProvider';

export const useEnrollPhoneNumber = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: phoneVerificationService.enrollPhoneNumber,
    onSuccess: () => {
      // Invalidate factors list after enrollment
      queryClient.invalidateQueries({ queryKey: ['phone-verification-factors'] });
      queryClient.invalidateQueries({ queryKey: ['mfa-aal'] });
    },
  });
};

export const useCreateChallenge = () => {
  return useMutation({
    mutationFn: phoneVerificationService.createChallenge,
  });
};

export const useVerifyChallenge = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: phoneVerificationService.verifyChallenge,
    onSuccess: () => {
      // Invalidate all phone verification related caches after successful verification
      queryClient.invalidateQueries({ queryKey: ['mfa-aal'] });
      queryClient.invalidateQueries({ queryKey: ['phone-verification-factors'] });
    },
  });
};

export const useChallengeAndVerify = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: phoneVerificationService.challengeAndVerify,
    onSuccess: () => {
      // Invalidate all phone verification related caches after successful verification
      queryClient.invalidateQueries({ queryKey: ['mfa-aal'] });
      queryClient.invalidateQueries({ queryKey: ['phone-verification-factors'] });
    },
  });
};

export const useListFactors = () => {
  const { user } = useAuth();
  
  return useQuery({
    queryKey: ['phone-verification-factors'],
    queryFn: phoneVerificationService.listFactors,
    enabled: !!user, // Only run when user is authenticated
    staleTime: Infinity, // 2 minutes
    retry: 2,
  });
};

export const useUnenrollFactor = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: phoneVerificationService.unenrollFactor,
    onSuccess: () => {
      // Invalidate caches after unenrolling
      queryClient.invalidateQueries({ queryKey: ['phone-verification-factors'] });
      queryClient.invalidateQueries({ queryKey: ['mfa-aal'] });
    },
  });
};



export const useUnenrollPhoneFactor = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: phoneVerificationService.unenrollFactor,
    onSuccess: () => {
      // Invalidate caches after unenrolling
      queryClient.invalidateQueries({ queryKey: ['phone-verification-factors'] });
      queryClient.invalidateQueries({ queryKey: ['mfa-aal'] });
    },
  });
};



export const useGetAAL = () => {
  const { user } = useAuth();
  
  return useQuery({
    queryKey: ['mfa-aal'],
    queryFn: phoneVerificationService.getAAL,
    enabled: !!user, // Only run when user is authenticated
    staleTime: Infinity, // 1 minute
    retry: 2,
  });
};