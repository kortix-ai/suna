/**
 * URL builder for the account admin surfaces mobile hands off to web
 * (Members, Groups and permissions, Git, Audit log). Mobile has no in-app
 * screens for these (see apps/mobile/design.md → Account page and account
 * screens): the account detail page opens the equivalent web tab in the
 * in-app browser (`expo-web-browser`).
 */

export type AccountHubTab = 'members' | 'groups' | 'git' | 'audit';

/** `${frontendUrl}/projects?accountId=<id>&accountTab=<tab>`, id encoded. */
export function accountHubUrl(frontendUrl: string, accountId: string, tab: AccountHubTab): string {
  return `${frontendUrl.replace(/\/$/, '')}/projects?accountId=${encodeURIComponent(accountId)}&accountTab=${tab}`;
}
