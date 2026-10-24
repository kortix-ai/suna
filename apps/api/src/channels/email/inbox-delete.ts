import { type EmailInstallSummary, listEmailInstalls, loadEmailApiKeyForProject } from '../install-store';
import { ResendEmailApiError, deleteResendInbox, deleteResendWebhook, resolveEmailApiKey } from '../resend-email-api';

/**
 * Remove on Resend what Kortix created for one email install: the inbox when
 * Kortix made it at connect (managed, or with the project's own key), and the
 * own-key team's webhook once no other inbox of this project uses it. An
 * inbox the person attached by id is only unlinked, never deleted. The
 * managed team's webhook is shared by every managed inbox on this API, so it
 * stays. Resend's 404 counts as done; any other failure throws, so the caller
 * keeps the install instead of leaking a paid inbox silently.
 */
export async function deleteEmailInbox(projectId: string, install: EmailInstallSummary): Promise<void> {
  const ownKey = await loadEmailApiKeyForProject(projectId, install.connectionSlug);
  if (install.createdByKortix) {
    const apiKey = resolveEmailApiKey(ownKey);
    if (!apiKey) {
      throw new ResendEmailApiError({ message: 'No Resend key can delete this inbox', status: 503, body: null, path: '/inboxes' });
    }
    await deleteResendInbox(apiKey, install.inboxId);
  }
  if (ownKey && install.webhookId) {
    const others = (await listEmailInstalls(projectId)).filter(
      (other) => other.connectionSlug !== install.connectionSlug && other.webhookId === install.webhookId,
    );
    if (others.length === 0) await deleteResendWebhook(ownKey, install.webhookId);
  }
}
