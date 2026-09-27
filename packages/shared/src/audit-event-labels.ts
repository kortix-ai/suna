/**
 * The title of every audit event a writer records outside a route: one line
 * per action.
 *
 * A route's own action and title live in `audit-route-labels.ts`. This file
 * holds the rest: events a sandbox, a worker, a database trigger, or a
 * handler records for something other than the request itself
 * (`secret.consumer.used`, `iam.assignment.expired`, `llm.usage`).
 *
 * A key ending in `.*` titles a family whose last segments are open-ended
 * (OpenCode event types). An exact key wins over a family; a longer family
 * wins over a shorter one.
 *
 * Title: what happened, past tense, sentence case, 2 to 7 words. An event a
 * route lists in its `events` may share that route's title: it is the same
 * change, recorded by the handler.
 * `apps/api/src/__tests__/unit-audit-route-labels.test.ts` fails for an
 * action a writer records without a line here or in the route catalog.
 */
// biome-ignore format: one action per line, so a diff names exactly the action that changed
export const AUDIT_EVENT_LABELS: Readonly<Record<string, string>> = {
  'api.rate_limit.exceeded': 'Hit API rate limit',
  'audit.anonymous.suppressed': 'Suppressed anonymous audit rows',
  'audit.reconciliation.completed': 'Completed audit reconciliation',
  'webhook.test': 'Sent audit webhook test',
  'auth.login.success': 'Signed in',
  'auth.login.fail': 'Failed to sign in',
  'auth.session.first_sight': 'Started authenticated session',
  'admin.impersonate.action': 'Acted while impersonating account',
  'billing.trial.converted': 'Converted trial to paid plan',
  'admin.account.temporary_access.grant': 'Granted temporary account access',
  'enterprise_demo.set': 'Recorded Enterprise preview override',
  'enterprise_demo.enable': 'Enabled Enterprise preview',
  'enterprise_demo.disable': 'Disabled Enterprise preview',
  'iam.assignment.granted': 'Granted a role',
  'iam.assignment.revoked': 'Revoked a role assignment',
  'iam.assignment.expired': 'Expired a role',
  'iam.member.super_admin.revoke': 'Revoked super-admin',
  'iam.mfa_required.enable': 'Required MFA for the account',
  'iam.mfa_required.disable': 'Disabled MFA requirement',
  'iam.session_oversight.enable': 'Let admins open every session',
  'iam.session_oversight.disable': 'Stopped admins opening every session',
  'project.admin_bypass_read': 'Used admin bypass to view project',
  'project.admin_bypass_session_read': 'Used admin bypass to view session',
  'project.admin_oversight_session_read': 'Opened a member session as account admin',
  'project.sandbox_provider.activated': 'Activated sandbox provider switch',
  'project.sandbox_provider.transition_failed': 'Failed sandbox provider switch',
  'app.deployment.activated': 'Activated Kortix App deployment',
  'app.deployment.failed': 'Failed Kortix App deployment',
  'git.branch.deleted': 'Deleted stale Git branch',
  'session.created': 'Recorded session creation',
  'session.status.changed': 'Changed session status',
  'session.lifecycle.create_session': 'Queued session creation',
  'session.lifecycle.continue_session': 'Queued session continuation',
  'session.event_rate_limited': 'Rate-limited session audit events',
  'sandbox.runtime.legacy_bootstrap': 'Bootstrapped legacy sandbox runtime',
  'opencode.*': 'Recorded agent runtime event',
  'opencode.tool.updated': 'Updated agent tool call',
  'opencode.message.part.*': 'Updated agent message',
  'secret.created': 'Created secret',
  'secret.deleted': 'Removed shared secret',
  'secret.strategy.changed': 'Updated secret delivery strategy',
  'secret.oauth.disconnected': 'Disconnected model provider OAuth login',
  'secret.updated': 'Updated secret',
  'secret.consumer.used': 'Used secret',
  'secret.consumer.missing': 'Requested a secret that is not set',
  'secret.consumer.denied': 'Denied secret to consumer',
  'secret.consumer.invalid': 'Failed to decrypt secret',
  'secret.consumer.refreshed': 'Refreshed secret credential',
  'secret.consumer.refresh_failed': 'Failed to refresh secret credential',
  'secret.handle.issued': 'Issued secret handle to sandbox',
  'secret.handle.refused': 'Refused secret handle',
  'secret.broker.requested': 'Requested secret broker call',
  'secret.broker.completed': 'Completed secret broker call',
  'secret.broker.streamed': 'Streamed secret relay response',
  'secret.broker.failed': 'Failed secret broker call',
  'secret.oauth.connected': 'Connected model provider OAuth login',
  'llm.request': 'Made LLM request',
  'connector.*': 'Ran connector call',
  'connector.approval.approved': 'Approved connector action',
  'connector.approval.denied': 'Denied connector action',
  'connector.computer.*': 'Ran computer operation',
  'llm.usage': 'Recorded LLM usage',
  'connector.computer.permission.expired': 'Expired computer tunnel permission',
  'tunnel.agent.authenticate': 'Authenticated computer tunnel agent',
};
