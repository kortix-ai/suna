import * as P from '../rest/projects-client';
export function bindAccounts() {
  return {
    list: P.listAccounts,
    get: P.getAccount,
    create: P.createAccount,
    secretResources: {
      list: P.listAccountSecretResources,
      create: P.createAccountSecretResource,
      rotate: P.rotateAccountSecretResource,
      retry: P.retryAccountSecretResource,
      remove: P.deleteAccountSecretResource,
      grant: P.grantAccountSecretResource,
      revoke: P.revokeAccountSecretResourceGrant,
      setAccess: P.setAccountSecretResourceAccess,
    },
    updateName: P.updateAccountName,
    /** Organization branding (Enterprise): own logo / icon / favicon (light + dark) and product name. */
    branding: {
      get: P.getAccountBranding,
      update: P.updateAccountBranding,
      uploadAsset: P.uploadAccountBrandingAsset,
      removeAsset: P.removeAccountBrandingAsset,
      reset: P.resetAccountBranding,
    },
    leave: P.leaveAccount,
    members: P.listAccountMembers,
    invite: P.inviteAccountMember,
    removeMember: P.removeAccountMember,
    updateMemberRole: P.updateAccountMemberRole,
    invites: P.listAccountInvites,
    /** Cancel a pending account invite (accountId still known/scoped). */
    cancelInvite: P.cancelAccountInvite,
    /** Resend a pending account invite (accountId still known/scoped). */
    resendInvite: P.resendAccountInvite,
    /** CLI PAT minting — account-scoped personal access tokens (`kortix_pat_...`). */
    tokens: {
      list: P.listAccountTokens,
      create: P.createAccountToken,
      revoke: P.revokeAccountToken,
    },
    /** Connected apps — the OAuth / MCP clients this person approved, across all accounts. */
    connectedApps: {
      list: P.listOAuthGrants,
      revoke: P.revokeOAuthGrant,
    },
    /** Enterprise audit log — events + CSV/JSONL export + SIEM webhooks. */
    audit: {
      log: P.listAccountAudit,
      export: P.exportAccountAudit,
      webhooks: {
        list: P.listAccountAuditWebhooks,
        create: P.createAccountAuditWebhook,
        update: P.updateAccountAuditWebhook,
        remove: P.removeAccountAuditWebhook,
      },
    },
  };

}
