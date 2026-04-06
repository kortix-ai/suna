import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authenticatedFetch } from '@/lib/auth-token';
import { getActiveOpenCodeUrl } from '@/stores/server-store';

export interface VerifyWhatsAppResult {
  ok: boolean;
  phone?: { id: string; display_phone_number: string; verified_name: string; quality_rating: string };
  error?: string;
}

/**
 * Verify WhatsApp Business credentials via the backend.
 */
export function useWhatsAppVerify() {
  return useMutation({
    mutationFn: async ({ accessToken, phoneNumberId }: { accessToken: string; phoneNumberId: string }): Promise<VerifyWhatsAppResult> => {
      const baseUrl = getActiveOpenCodeUrl();
      if (!baseUrl) return { ok: false, error: 'No active instance' };
      try {
        const res = await authenticatedFetch(`${baseUrl}/kortix/channels/verify-whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken, phoneNumberId }),
        });
        return await res.json() as VerifyWhatsAppResult;
      } catch {
        return { ok: false, error: 'Failed to verify WhatsApp credentials' };
      }
    },
  });
}

export function useWhatsAppConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ accessToken, phoneNumberId, publicUrl, createdBy, defaultAgent, defaultModel, webhookVerifyToken }: {
      accessToken: string;
      phoneNumberId: string;
      publicUrl?: string;
      createdBy?: string;
      defaultAgent?: string;
      defaultModel?: string;
      webhookVerifyToken?: string;
    }) => {
      const baseUrl = getActiveOpenCodeUrl();
      if (!baseUrl) throw new Error('No active instance');
      const res = await authenticatedFetch(`${baseUrl}/kortix/channels/setup/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, phoneNumberId, publicUrl, createdBy, defaultAgent, defaultModel, webhookVerifyToken }),
      });
      const data = await res.json() as any;
      if (!data.ok) throw new Error(data.error || 'Setup failed');
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}
