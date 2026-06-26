'use client';

/**
 * The one place apps/web wires itself into @kortix/sdk. The entire data layer
 * now lives in the SDK; this injects web's identity (Supabase token + user) and
 * its UI sinks (toast / OS notifications) into the single config seam. Imported
 * for side-effect by the root provider so it runs before any SDK call.
 */
import { configureKortix } from '@kortix/sdk';
import { getSupabaseAccessToken } from '@/lib/auth-token';
import { isBillingEnabled } from '@/lib/config';
import { getEnv } from '@/lib/env-config';
import { handleApiError } from '@/lib/error-handler';
import { createClient } from '@/lib/supabase/client';
import { errorToast, infoToast, successToast, warningToast } from '@/components/ui/toast';
import {
  notifyPermissionRequest,
  notifyQuestion,
  notifySessionError,
  notifyTaskComplete,
} from '@/lib/web-notifications';

let configured = false;

export function ensureKortixConfigured(): void {
  if (configured) return;
  configured = true;

  configureKortix({
    backendUrl: getEnv().BACKEND_URL,
    getToken: () => getSupabaseAccessToken(),
    getUserId: async () => {
      try {
        const {
          data: { user },
        } = await createClient().auth.getUser();
        return user?.id ?? null;
      } catch {
        return null;
      }
    },
    sandboxId: getEnv().SANDBOX_ID ?? null,
    billingEnabled: isBillingEnabled(),
    onToast: (level, message, options) => {
      const opts = options as Parameters<typeof infoToast>[1];
      if (level === 'success') successToast(message, opts);
      else if (level === 'error') errorToast(message, opts);
      else if (level === 'warning') warningToast(message, opts);
      else infoToast(message, opts);
    },
    onNotify: (e) => {
      const title = e.sessionTitle as string | undefined;
      if (e.kind === 'task-complete') notifyTaskComplete(e.sessionId, title);
      else if (e.kind === 'session-error') notifySessionError(e.sessionId, e.errorTitle as string, title);
      else if (e.kind === 'question') notifyQuestion(e.sessionId, e.questionText as string, title);
      else if (e.kind === 'permission')
        notifyPermissionRequest(e.sessionId, e.toolName as string, title);
    },
    onError: (error, context) => handleApiError(error, context as Parameters<typeof handleApiError>[1]),
  });
}

ensureKortixConfigured();
