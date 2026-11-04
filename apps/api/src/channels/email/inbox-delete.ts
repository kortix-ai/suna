import { type EmailInboxAccount, emailOwnKeyForAccount, listEmailInboxAccounts } from '../install-store';
import { ResendEmailApiError, deleteResendInbox, deleteResendWebhook, resolveEmailApiKey } from '../resend-email-api';

/**
 * Remove on Resend what Kortix created for one inbox account: the inbox when
 * Kortix made it (managed, or with the account's own key), and the own-key
 * team's webhook once no other inbox of this project uses it. An inbox the
 * person attached by id is only unlinked, never deleted. The managed team's
 * webhook is shared by every managed inbox on this API, so it stays. Resend's
 * 404 counts as done; any other failure throws, so the caller keeps the
 * account instead of leaking a paid inbox silently.
 */
export async function deleteEmailInbox(account: EmailInboxAccount): Promise<void> {
  const ownKey = await emailOwnKeyForAccount(account);
  if (account.createdByKortix) {
    const apiKey = resolveEmailApiKey(ownKey);
    if (!apiKey) {
      throw new ResendEmailApiError({ message: 'No Resend key can delete this inbox', status: 503, body: null, path: '/inboxes' });
    }
    await deleteResendInbox(apiKey, account.inboxId);
  }
  if (ownKey && account.webhookId) {
    const others = (await listEmailInboxAccounts(account.projectId)).filter(
      (other) => other.connectionId !== account.connectionId && other.webhookId === account.webhookId,
    );
    if (others.length === 0) await deleteResendWebhook(ownKey, account.webhookId);
  }
}
