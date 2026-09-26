/**
 * The account screen, as pixels and keys only (SPEC §5.9).
 *
 * Everything it draws arrives as a prop and everything it does leaves as a
 * callback — the same split `features/sidebar/sidebar-view.tsx` uses, and for
 * the same reason: the frame assertions in `account-view.test.tsx` run against
 * fixtures with no mocked module, while `account-screen.tsx` owns the real SDK
 * reads.
 *
 * The API shapes are declared structurally here rather than imported. `@kortix/sdk`
 * exports `AccountMember` and `AccountState` from its root but NOT
 * `AccountInvitation`, `IamRole`, or `BillingState`, so importing "the" invite
 * type would mean a deep import into `src/core/rest/...`, i.e. a private path.
 * Structural inputs keep this file on the public surface and keep the mappers
 * callable from a test with a literal.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { matchesAccountBinding } from './match.ts';

export type AccountTab = 'members' | 'invites' | 'roles' | 'billing';

export const ACCOUNT_TABS: readonly AccountTab[] = [
  'members',
  'invites',
  'roles',
  'billing',
] as const;

const TAB_LABEL: Record<AccountTab, string> = {
  members: 'Members',
  invites: 'Invites',
  roles: 'Roles',
  billing: 'Billing',
};

/** The account roles an invite may carry. Mirrors the SDK's `AccountRole`. */
export const INVITE_ROLES = ['member', 'admin', 'owner'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

// ─── Inputs (structural, see the file header) ───────────────────────────────

export interface MemberInput {
  user_id: string;
  email: string | null;
  account_role: string;
  joined_at: string;
  has_verified_mfa?: boolean;
  explicit_project_count?: number;
}

export interface InviteInput {
  invite_id: string;
  email: string;
  initial_role: string;
  created_at: string;
  expires_at: string;
}

export interface RoleInput {
  role_id: string;
  key: string;
  name: string;
  description: string | null;
  resource_type: string;
  is_system: boolean;
}

export interface BillingInput {
  credits?: { total?: number; daily?: number; monthly?: number; extra?: number; can_run?: boolean };
  billing_state?: string;
  plan?: { label?: string; sublabel?: string | null };
  subscription?: { tier_display_name?: string; can_purchase_credits?: boolean };
  tier?: { name?: string; display_name?: string; monthly_credits?: number };
  seats?: { count?: number };
}

// ─── View models (pure) ─────────────────────────────────────────────────────

export interface Row {
  id: string;
  label: string;
  right: string;
  dim?: boolean;
}

export function memberRows(members: MemberInput[], now: number): Row[] {
  return members.map((member) => ({
    id: member.user_id,
    label: member.email || member.user_id,
    right: `${member.account_role} · ${relativeAge(Date.parse(member.joined_at), now)}`,
  }));
}

/** An invite is pending until its `expires_at` passes. The API stores no other state. */
export function inviteStatus(invite: InviteInput, now: number): 'pending' | 'expired' {
  return Date.parse(invite.expires_at) <= now ? 'expired' : 'pending';
}

export function inviteRows(invites: InviteInput[], now: number): Row[] {
  return invites.map((invite) => {
    const status = inviteStatus(invite, now);
    return {
      id: invite.invite_id,
      label: invite.email,
      right: `${invite.initial_role} · ${status} · ${relativeAge(Date.parse(invite.created_at), now)}`,
      dim: status === 'expired',
    };
  });
}

export function roleRows(roles: RoleInput[]): Row[] {
  return roles.map((role) => ({
    id: role.role_id,
    label: role.description ? `${role.name} — ${role.description}` : role.name,
    right: `${role.resource_type}${role.is_system ? '' : ' · custom'}`,
  }));
}

export interface BillingViewModel {
  planLabel: string;
  planSublabel: string | null;
  /** The API's own `billing_state`, or the state derivable from `can_run`. */
  state: string;
  /** True when the API will refuse to start a session. Renders the banner. */
  blocked: boolean;
  blockedReason: string | null;
  credits: { total: number; daily: number; monthly: number; extra: number };
  tierName: string;
  seats: number | null;
  canPurchaseCredits: boolean;
}

const BLOCK_REASON: Record<string, string> = {
  out_of_credits: 'Out of credits. Sessions are blocked until the balance is topped up.',
  payment_failed: 'Payment failed. Billing is blocked until the card is fixed.',
  no_subscription: 'No subscription. Sessions are blocked on this plan.',
  no_account: 'No billing account for this account id.',
};

/**
 * `AccountState` → what the Billing tab prints.
 *
 * Branch on `billing_state`, never on `tier_key` and never on `can_run` alone —
 * the rule the SDK states on `BillingState` itself. `can_run === false` with a
 * missing `billing_state` (an older API) still blocks, so both are read.
 *
 * The plan LABEL is re-derived here because the SDK's own `resolvedPlan` helper
 * is not on the public export surface (see the report's SDK gaps).
 */
export function billingView(state: BillingInput | null | undefined): BillingViewModel {
  const credits = {
    total: state?.credits?.total ?? 0,
    daily: state?.credits?.daily ?? 0,
    monthly: state?.credits?.monthly ?? 0,
    extra: state?.credits?.extra ?? 0,
  };
  const canRun = state?.credits?.can_run !== false;
  const billingState = state?.billing_state ?? (canRun ? 'active' : 'out_of_credits');
  const blocked = billingState !== 'active' || !canRun;
  return {
    planLabel:
      state?.plan?.label ||
      state?.tier?.display_name ||
      state?.subscription?.tier_display_name ||
      'No plan',
    planSublabel: state?.plan?.sublabel ?? null,
    state: billingState,
    blocked,
    blockedReason: blocked
      ? (BLOCK_REASON[billingState] ??
        'Blocked: the API will refuse to start a session on this account.')
      : null,
    credits,
    tierName: state?.tier?.name ?? state?.subscription?.tier_display_name ?? 'none',
    seats: state?.seats?.count ?? null,
    canPurchaseCredits: state?.subscription?.can_purchase_credits === true,
  };
}

/** Credits are fractional. Two decimals, so a row never changes width mid-session. */
export function formatCredits(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface AccountViewProps {
  /** Account display name, from `accounts.get`. */
  accountName: string;
  accountId: string;
  /** The caller's role on this account. Empty when unknown. */
  viewerRole: string;
  tab: AccountTab;
  onTabChange(tab: AccountTab): void;
  /** Only a focused screen answers keys. */
  focused: boolean;
  width: number;
  height: number;
  /** The clock every age column is rendered against. A prop, never `Date.now()`. */
  now: number;
  members: MemberInput[];
  invites: InviteInput[];
  roles: RoleInput[];
  billing: BillingInput | null;
  loading: boolean;
  /** SDK error text for the active tab, verbatim. */
  errorMessage: string | null;
  /** One dim line under the rows: `inviting…`, `cancelling…`. */
  busyMessage?: string | null;
  /** The web URL that owns checkout. Printed on `u`; the TUI never charges a card. */
  billingUrl: string;
  onBack(): void;
  onInvite(input: { email: string; role: InviteRole }): void;
  onCancelInvite(inviteId: string): void;
  /** Null when the SDK exposes no cancel — the row then renders the key greyed. */
  canCancelInvite: boolean;
  onRefresh(): void;
  onToast?(message: string, kind?: 'info' | 'error'): void;
}

export function AccountView({
  accountName,
  accountId,
  viewerRole,
  tab,
  onTabChange,
  focused,
  width,
  height,
  now,
  members,
  invites,
  roles,
  billing,
  loading,
  errorMessage,
  busyMessage = null,
  billingUrl,
  onBack,
  onInvite,
  onCancelInvite,
  canCancelInvite,
  onRefresh,
  onToast,
}: AccountViewProps) {
  const [mode, setMode] = useState<'browse' | 'invite-email' | 'invite-role' | 'confirm-cancel'>(
    'browse',
  );
  const [cursor, setCursor] = useState(0);
  const [draftEmail, setDraftEmail] = useState('');
  const [draftRole, setDraftRole] = useState<InviteRole>('member');

  const rows = useMemo<Row[]>(() => {
    if (tab === 'members') return memberRows(members, now);
    if (tab === 'invites') return inviteRows(invites, now);
    if (tab === 'roles') return roleRows(roles);
    return [];
  }, [tab, members, invites, roles, now]);

  // A tab switch, a cancel, or a refetch can shorten the list under the cursor.
  useEffect(() => {
    setCursor((current) => Math.min(Math.max(current, 0), Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  const currentRow = rows[cursor] ?? null;
  const billingModel = useMemo(() => billingView(billing), [billing]);

  const stepTab = useCallback(
    (direction: 1 | -1) => {
      const index = ACCOUNT_TABS.indexOf(tab);
      const next = (index + direction + ACCOUNT_TABS.length) % ACCOUNT_TABS.length;
      onTabChange(ACCOUNT_TABS[next] as AccountTab);
      setCursor(0);
    },
    [tab, onTabChange],
  );

  const leaveForm = useCallback(() => {
    setMode('browse');
    setDraftEmail('');
  }, []);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'invite-email') {
      // The email `<input>` owns every other key. Esc is the ONLY chord the
      // screen still claims here: a letter chord (`r` for the role) would be
      // stolen from the address being typed — which is exactly what happened
      // when `r` cycled the role, and why the role is a second step instead.
      if (matchesAccountBinding(key, 'account.back')) leaveForm();
      return;
    }
    if (mode === 'invite-role') {
      // No `<input>` is mounted in this step, so every chord is the screen's.
      if (matchesAccountBinding(key, 'account.back')) return setMode('invite-email');
      if (
        matchesAccountBinding(key, 'account.role') ||
        matchesAccountBinding(key, 'account.down') ||
        matchesAccountBinding(key, 'account.tab.next')
      ) {
        key.preventDefault();
        return setDraftRole((role) => {
          const index = INVITE_ROLES.indexOf(role);
          return INVITE_ROLES[(index + 1) % INVITE_ROLES.length] as InviteRole;
        });
      }
      if (
        matchesAccountBinding(key, 'account.up') ||
        matchesAccountBinding(key, 'account.tab.prev')
      ) {
        key.preventDefault();
        return setDraftRole((role) => {
          const index = INVITE_ROLES.indexOf(role);
          return INVITE_ROLES[
            (index - 1 + INVITE_ROLES.length) % INVITE_ROLES.length
          ] as InviteRole;
        });
      }
      if (key.name === 'return') {
        key.preventDefault();
        const email = draftEmail.trim();
        const role = draftRole;
        leaveForm();
        if (email) onInvite({ email, role });
      }
      return;
    }
    if (mode === 'confirm-cancel') {
      if (matchesAccountBinding(key, 'account.back')) return setMode('browse');
      if (matchesAccountBinding(key, 'account.deny')) return setMode('browse');
      if (matchesAccountBinding(key, 'account.confirm')) {
        const target = currentRow?.id;
        setMode('browse');
        if (target) onCancelInvite(target);
      }
      return;
    }

    if (matchesAccountBinding(key, 'account.back')) return onBack();
    if (matchesAccountBinding(key, 'account.tab.next')) return stepTab(1);
    if (matchesAccountBinding(key, 'account.tab.prev')) return stepTab(-1);
    if (matchesAccountBinding(key, 'account.tab.members')) return onTabChange('members');
    if (matchesAccountBinding(key, 'account.tab.invites')) return onTabChange('invites');
    if (matchesAccountBinding(key, 'account.tab.roles')) return onTabChange('roles');
    if (matchesAccountBinding(key, 'account.tab.billing')) return onTabChange('billing');
    if (matchesAccountBinding(key, 'account.refresh')) return onRefresh();
    if (matchesAccountBinding(key, 'account.down'))
      return setCursor((value) => Math.min(value + 1, Math.max(rows.length - 1, 0)));
    if (matchesAccountBinding(key, 'account.up'))
      return setCursor((value) => Math.max(value - 1, 0));

    if (tab === 'invites') {
      if (matchesAccountBinding(key, 'account.invite')) {
        setDraftEmail('');
        setDraftRole('member');
        setMode('invite-email');
        return;
      }
      if (matchesAccountBinding(key, 'account.cancelInvite')) {
        if (!currentRow) return;
        if (!canCancelInvite) {
          onToast?.('This SDK build exposes no invite cancel.', 'error');
          return;
        }
        setMode('confirm-cancel');
        return;
      }
    }
    if (tab === 'billing' && matchesAccountBinding(key, 'account.billingUrl')) {
      onToast?.(`Billing lives on the web: ${billingUrl}`);
    }
  });

  const bodyWidth = Math.max(width - 2, 12);
  const formOpen = mode === 'invite-email' || mode === 'invite-role';
  const chrome = 5 + (formOpen ? 3 : 0) + (mode === 'confirm-cancel' ? 3 : 0);
  const rowsAvailable = Math.max(height - chrome, 1);
  const start = windowStart(cursor, rows.length, rowsAvailable);
  const visible = rows.slice(start, start + rowsAvailable);

  return (
    <box flexDirection="column" width={width} height={height} padding={1}>
      <text fg={theme.fg}>{layoutRow(accountName || accountId, viewerRole || '', bodyWidth)}</text>

      <text>
        {ACCOUNT_TABS.map((entry, position) => (
          <span key={entry} fg={entry === tab ? theme.fg : theme.faint}>
            {`${position > 0 ? ' · ' : ''}${position + 1} ${TAB_LABEL[entry]}`}
          </span>
        ))}
      </text>
      <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>

      {tab === 'billing' ? (
        <box flexDirection="column" width={bodyWidth}>
          {billingModel.blocked ? (
            <box
              border
              borderStyle="single"
              borderColor={theme.danger}
              width={bodyWidth}
              paddingLeft={1}
              paddingRight={1}
              flexDirection="column"
            >
              <text fg={theme.danger}>{billingModel.state.replace(/_/g, ' ').toUpperCase()}</text>
              <text fg={theme.fg}>{billingModel.blockedReason ?? ''}</text>
            </box>
          ) : null}
          <text fg={theme.fg}>
            {layoutRow(
              `Plan  ${billingModel.planLabel}${billingModel.planSublabel ? ` · ${billingModel.planSublabel}` : ''}`,
              billingModel.state,
              bodyWidth,
            )}
          </text>
          <text fg={theme.dim}>
            {layoutRow(
              `Credits  ${formatCredits(billingModel.credits.total)}`,
              `monthly ${formatCredits(billingModel.credits.monthly)} · extra ${formatCredits(billingModel.credits.extra)}`,
              bodyWidth,
            )}
          </text>
          <text fg={theme.dim}>
            {layoutRow(
              `Tier  ${billingModel.tierName}`,
              billingModel.seats == null ? '' : `${billingModel.seats} seats`,
              bodyWidth,
            )}
          </text>
          <text fg={theme.faint}>
            {layoutRow(
              `Members  ${members.length}`,
              billingModel.canPurchaseCredits ? 'credit top-up available' : '',
              bodyWidth,
            )}
          </text>
          <text fg={theme.faint}>u prints the web billing URL — the TUI never runs checkout.</text>
        </box>
      ) : (
        visible.map((row, offset) => {
          const isCursor = start + offset === cursor;
          return (
            <text
              key={row.id}
              fg={isCursor ? theme.fg : row.dim ? theme.faint : theme.dim}
              bg={isCursor ? theme.surface : undefined}
            >
              <span fg={theme.accent}>{isCursor && focused ? '▌' : ' '}</span>
              {layoutRow(row.label, row.right, Math.max(bodyWidth - 1, 0))}
            </text>
          );
        })
      )}

      {tab !== 'billing' && loading && rows.length === 0 ? (
        <Spinner label={`loading ${TAB_LABEL[tab].toLowerCase()}`} />
      ) : null}
      {tab !== 'billing' && !loading && !errorMessage && rows.length === 0 ? (
        <text fg={theme.faint}>
          {tab === 'invites' ? 'No pending invites. Press i to invite someone.' : 'Nothing here.'}
        </text>
      ) : null}
      {errorMessage ? <text fg={theme.danger}>{errorMessage}</text> : null}

      {mode === 'invite-email' ? (
        <box flexDirection="column" width={bodyWidth}>
          <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
          <box flexDirection="row" width={bodyWidth}>
            <text fg={theme.fg}>Invite email </text>
            <input
              focused
              flexGrow={1}
              value={draftEmail}
              placeholder="person@company.com"
              maxLength={254}
              onInput={setDraftEmail}
              onSubmit={() => {
                if (draftEmail.trim()) setMode('invite-role');
              }}
            />
          </box>
          <text fg={theme.faint}>Enter next · Esc cancel</text>
        </box>
      ) : null}

      {mode === 'invite-role' ? (
        <box flexDirection="column" width={bodyWidth}>
          <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
          <text fg={theme.fg}>{`Invite ${draftEmail.trim()} as`}</text>
          <text>
            {INVITE_ROLES.map((role) => (
              <span key={role} fg={role === draftRole ? theme.fg : theme.faint}>
                {`${role === draftRole ? ' ▌' : '  '}${role}`}
              </span>
            ))}
          </text>
          <text fg={theme.faint}>Enter send · r / j / k role · Esc back</text>
        </box>
      ) : null}

      {mode === 'confirm-cancel' && currentRow ? (
        <box flexDirection="column" width={bodyWidth}>
          <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
          <text fg={theme.danger}>{`Cancel the invite for ${currentRow.label}?`}</text>
          <text fg={theme.faint}>y cancel it · n keep · Esc back</text>
        </box>
      ) : null}

      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}

      <box flexGrow={1} />
      <text fg={theme.faint}>
        {tab === 'invites'
          ? 'i invite · x cancel · 1-4 tabs · R refresh · Esc back'
          : tab === 'billing'
            ? 'u billing URL · 1-4 tabs · R refresh · Esc back'
            : '1-4 tabs · j/k move · R refresh · Esc back'}
      </text>
    </box>
  );
}
