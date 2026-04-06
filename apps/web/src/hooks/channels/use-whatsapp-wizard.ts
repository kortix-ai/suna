import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authenticatedFetch } from '@/lib/auth-token';
import { getActiveOpenCodeUrl } from '@/stores/server-store';

export interface WhatsAppQrResult {
  ok: boolean;
  qrDataUrl?: string | null;
  message: string;
  alreadyConnected?: boolean;
}

export interface WhatsAppStatusResult {
  ok: boolean;
  status: string;
  connected: boolean;
  qrDataUrl?: string | null;
  qrExpired?: boolean;
  message: string;
  selfJid?: string;
}

export interface WhatsAppWaitResult {
  ok: boolean;
  connected: boolean;
  message: string;
}

/**
 * Generate a WhatsApp QR code for login via the sandbox channels service.
 */
export function useWhatsAppGenerateQr() {
  return useMutation({
    mutationFn: async ({ force }: { force?: boolean } = {}): Promise<WhatsAppQrResult> => {
      const baseUrl = getActiveOpenCodeUrl();
      if (!baseUrl) throw new Error('No active instance');
      const res = await authenticatedFetch(`${baseUrl}/kortix/channels/whatsapp/qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !!force }),
      });
      return await res.json() as WhatsAppQrResult;
    },
  });
}

/**
 * Wait for the WhatsApp QR code to be scanned and connection established.
 */
export function useWhatsAppWaitForConnection() {
  return useMutation({
    mutationFn: async ({ timeoutMs }: { timeoutMs?: number } = {}): Promise<WhatsAppWaitResult> => {
      const baseUrl = getActiveOpenCodeUrl();
      if (!baseUrl) throw new Error('No active instance');
      const res = await authenticatedFetch(`${baseUrl}/kortix/channels/whatsapp/wait`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeoutMs: timeoutMs || 120_000 }),
      });
      return await res.json() as WhatsAppWaitResult;
    },
  });
}

/**
 * Full WhatsApp connect flow: generate QR, wait for scan, create channel.
 */
export function useWhatsAppConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ defaultAgent, defaultModel }: {
      defaultAgent?: string;
      defaultModel?: string;
    }) => {
      const baseUrl = getActiveOpenCodeUrl();
      if (!baseUrl) throw new Error('No active instance');
      const res = await authenticatedFetch(`${baseUrl}/kortix/channels/setup/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultAgent, defaultModel }),
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
