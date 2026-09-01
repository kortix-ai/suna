/**
 * The account hub's section catalog — the ONE list of what `/accounts/[id]`
 * can show, and what each section is called.
 *
 * Shared by the page (`app/(app)/accounts/[id]/page.tsx`, which renders the
 * pane) and the settings shell (`account-settings-shell.tsx`, which renders
 * the sidebar nav and the breadcrumb). It used to live inside `page.tsx`; the
 * sidebar moved out to `accounts/layout.tsx` so every `/accounts/**` route
 * sits in the same frame, and a layout cannot read a page's module-level
 * constants. Nothing here fetches — it is names, icons, and order.
 */
import type { Icon } from '@phosphor-icons/react';
import {
  CoinsIcon,
  CreditCardIcon,
  FingerprintIcon,
  FolderOpenIcon,
  GearSixIcon,
  GitBranchIcon,
  KeyIcon,
  NetworkIcon,
  PaintBrushIcon,
  QuestionIcon,
  ScrollIcon,
  ShieldIcon,
  UsersIcon,
} from '@phosphor-icons/react';

export const VALID_TABS = [
  'members',
  'git',
  'tokens',
  'settings',
  'branding',
  'billing',
  'transactions',
  'groups',
  'access-projects',
  'roles',
  'identity',
  'audit',
  'help',
] as const;
export type AccountSection = (typeof VALID_TABS)[number];

export interface AccountNavItem {
  id: AccountSection;
  label: string;
  icon: Icon;
}

export interface AccountNavGroup {
  /**
   * The group's name. Carried as the list's `aria-label` — the sidebar draws
   * the groups apart with a gap, not a heading, so a screen reader still gets
   * the word a sighted reader infers from the whitespace.
   */
  label?: string;
  items: readonly AccountNavItem[];
}

// Three groups. The unlabeled plumbing group (Settings/Git/Tokens —
// name, security, repo, machine tokens) leads: "who am I and how is this
// account configured" comes before "who else is in it" (Marko's call,
// 2026-08-18 — was Access-first; moved Settings ahead of it). Everything
// access-control-shaped lives in one "Access" cluster right after — Members /
// Groups / Projects / Roles / Identity / Audit log / Help are all
// facets of the same concern (who's in the account, what pools they're in,
// what those pools can do, where they can do it, how they signed in, and what
// happened) — deliberately not split into a separate "Enterprise" heading
// (Marko's call, 2026-08-18: Identity/Audit are access control too, plan-gating
// doesn't change what category they're in). Billing is unchanged.
//
// There is no "Agents" item: an agent is a project RESOURCE, not a principal,
// so agent access is the Agents field on a project grant (`AccessDialog`), not
// a tab of its own. Help closes the group — it is the old
// `PermissionsHelpPopover`, promoted to a linkable pane.
export const NAV_GROUPS: readonly AccountNavGroup[] = [
  {
    items: [
      { id: 'settings', label: 'Settings', icon: GearSixIcon },
      // Organization branding (Enterprise): the account's own logo, icon,
      // favicon (light + dark), and product name for every member. Sits with
      // the other "how is this account configured" items, not under Access.
      { id: 'branding', label: 'Branding', icon: PaintBrushIcon },
      { id: 'git', label: 'Git', icon: GitBranchIcon },
      { id: 'tokens', label: 'Tokens', icon: KeyIcon },
    ],
  },
  {
    label: 'Access',
    items: [
      { id: 'members', label: 'Members', icon: UsersIcon },
      { id: 'groups', label: 'Groups', icon: NetworkIcon },
      { id: 'access-projects', label: 'Projects', icon: FolderOpenIcon },
      { id: 'roles', label: 'Roles', icon: ShieldIcon },
      { id: 'identity', label: 'Identity', icon: FingerprintIcon },
      { id: 'audit', label: 'Audit log', icon: ScrollIcon },
      { id: 'help', label: 'Help', icon: QuestionIcon },
    ],
  },
  {
    label: 'Billing',
    items: [
      { id: 'billing', label: 'Plan', icon: CreditCardIcon },
      { id: 'transactions', label: 'Usage', icon: CoinsIcon },
    ],
  },
];

// Header block for sections whose content doesn't carry its own title.
export const PANE_META: Partial<Record<AccountSection, { title: string; description: string }>> = {
  members: { title: 'Members', description: 'People with access to this account.' },
  billing: { title: 'Plan', description: 'Plan, wallet, and spend for this account.' },
  transactions: {
    title: 'Usage',
    description: 'Session costs and credit ledger for this account.',
  },
  tokens: {
    title: 'Tokens',
    // Machine identities only. A person's own API keys moved to their own
    // settings on 2026-08-18 (`/settings/tokens`).
    description: 'Service account tokens for CI and automations, and the rules they follow.',
  },
  identity: {
    title: 'Identity',
    description: 'Bring members in from your identity provider.',
  },
  roles: {
    title: 'Roles',
    description: 'Built-in and custom roles. Assign them from Members and Projects.',
  },
  help: {
    title: 'Help',
    description: 'How access works in this account.',
  },
  settings: { title: 'Settings', description: 'Name and security for this account.' },
  branding: {
    title: 'Branding',
    description: 'Your logo, icon, favicon, and product name for everyone in this account.',
  },
};

/**
 * How wide a section's column is. The default is the page container
 * (`max-w-2xl`); list-shaped panes — a members table, an audit log — need the
 * next step up, and the usage ledger needs the room a table with seven
 * columns takes.
 */
export type AccountPaneWidth = 'default' | 'wide' | 'full';

const PANE_WIDTH: Partial<Record<AccountSection, AccountPaneWidth>> = {
  members: 'wide',
  groups: 'wide',
  'access-projects': 'wide',
  roles: 'wide',
  audit: 'wide',
  billing: 'wide',
  transactions: 'full',
};

export function paneWidth(section: AccountSection): AccountPaneWidth {
  return PANE_WIDTH[section] ?? 'default';
}

/**
 * `?tab=` → section, or `null` for anything that is not one. Legacy callers
 * pass `tab=overview` — the limits/wallet/spend panels now live at the top of
 * the Billing tab, so fold it.
 */
export function parseAccountSection(raw: string | null | undefined): AccountSection | null {
  const value = raw === 'overview' ? 'billing' : raw;
  return value && (VALID_TABS as readonly string[]).includes(value)
    ? (value as AccountSection)
    : null;
}

export function sectionLabel(section: AccountSection): string {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((entry) => entry.id === section);
    if (item) return item.label;
  }
  return section;
}

export interface HubCrumb {
  label: string;
  /** Absent on the last crumb — the page you are on is not a link. */
  href?: string;
  /** The account crumb before its record has loaded: render a placeholder, not "Account". */
  pending?: boolean;
  /**
   * The account crumb. Desktop shows `Settings / <account> / <section>`;
   * below `md` the bar is too narrow for three, so this one is hidden and
   * the row reads `Settings / <section>` — the sheet sidebar names the account.
   */
  kind?: 'account';
}

/**
 * The breadcrumb for a `/accounts/**` URL:
 * `Settings / <account name> / <where you are>`.
 *
 * Pure so the shell's top bar can be reasoned about without a router: the
 * pathname, the account, its name, and the resolved section are the whole
 * input. The account crumb links to the hub itself. The two guided-setup
 * routes and the token detail route hang off a hub section, so they get a
 * fourth crumb and their third links back into that section's pane.
 */
export function accountHubCrumbs(
  pathname: string,
  accountId: string | undefined,
  activeSection: AccountSection,
  accountName?: string | null,
): HubCrumb[] {
  const root: HubCrumb = { label: 'Settings', href: '/accounts' };
  if (!accountId) return [root, { label: 'Accounts' }];
  const hub = `/accounts/${accountId}`;
  const account: HubCrumb = accountName
    ? { label: accountName, href: hub, kind: 'account' }
    : { label: 'Account', href: hub, pending: true, kind: 'account' };
  const rest = pathname.startsWith(hub) ? pathname.slice(hub.length) : '';
  const [, sub] = rest.split('/');
  switch (sub) {
    case 'sso-setup':
      return [
        root,
        account,
        { label: 'Identity', href: `${hub}?tab=identity` },
        { label: 'SSO setup' },
      ];
    case 'scim-setup':
      return [
        root,
        account,
        { label: 'Identity', href: `${hub}?tab=identity` },
        { label: 'Directory sync setup' },
      ];
    case 'tokens':
      return [root, account, { label: 'Tokens', href: `${hub}?tab=tokens` }, { label: 'Token' }];
    case 'groups':
      return [root, account, { label: sectionLabel('groups') }];
    case 'members':
      return [root, account, { label: sectionLabel('members') }];
    default:
      return [root, account, { label: sectionLabel(activeSection) }];
  }
}
