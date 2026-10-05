import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import {
  type AccountTab,
  AccountView,
  type BillingInput,
  type InviteInput,
  type MemberInput,
  type RoleInput,
  billingView,
  formatCredits,
  inviteRows,
  inviteStatus,
  memberRows,
  roleRows,
} from './account-view.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-09-17T12:00:00.000Z');

const MEMBERS: MemberInput[] = [
  {
    user_id: 'u1',
    email: 'owner@kortix.test',
    account_role: 'owner',
    joined_at: '2026-09-17T11:00:00.000Z',
  },
  {
    user_id: 'u2',
    email: null,
    account_role: 'member',
    joined_at: '2026-08-17T12:00:00.000Z',
  },
];

const INVITES: InviteInput[] = [
  {
    invite_id: 'inv-1',
    email: 'pending@kortix.test',
    initial_role: 'member',
    created_at: '2026-09-17T10:00:00.000Z',
    expires_at: '2026-09-24T10:00:00.000Z',
  },
  {
    invite_id: 'inv-2',
    email: 'stale@kortix.test',
    initial_role: 'admin',
    created_at: '2026-08-01T10:00:00.000Z',
    expires_at: '2026-08-08T10:00:00.000Z',
  },
];

const ROLES: RoleInput[] = [
  {
    role_id: 'builtin:owner',
    key: 'owner',
    name: 'Owner',
    description: 'Full account control.',
    resource_type: 'account',
    is_system: true,
  },
  {
    role_id: 'custom:auditor',
    key: 'auditor',
    name: 'Auditor',
    description: null,
    resource_type: 'project',
    is_system: false,
  },
];

const ACTIVE_BILLING: BillingInput = {
  credits: { total: 2, daily: 0, monthly: 2, extra: 0, can_run: true },
  billing_state: 'active',
  plan: { key: 'free', label: 'Free', sublabel: null } as BillingInput['plan'],
  subscription: { tier_display_name: 'Free', can_purchase_credits: false },
  tier: { name: 'free', display_name: 'Free', monthly_credits: 2 },
};

function view(props: Partial<React.ComponentProps<typeof AccountView>> = {}) {
  return (
    <AccountView
      accountName="Agent G Org"
      accountId="acc-1"
      viewerRole="owner"
      tab="members"
      onTabChange={() => {}}
      focused
      width={72}
      height={16}
      now={NOW}
      members={MEMBERS}
      invites={INVITES}
      roles={ROLES}
      billing={ACTIVE_BILLING}
      loading={false}
      errorMessage={null}
      billingUrl="https://kortix.com/projects?accountId=acc-1&accountTab=billing"
      onBack={() => {}}
      onInvite={() => {}}
      onCancelInvite={() => {}}
      canCancelInvite
      onRefresh={() => {}}
      {...props}
    />
  );
}

describe('row mappers', () => {
  test('memberRows prints the email, the role, and the joined age', () => {
    expect(memberRows(MEMBERS, NOW)).toEqual([
      { id: 'u1', label: 'owner@kortix.test', right: 'owner · 1h' },
      { id: 'u2', label: 'u2', right: 'member · 1mo' },
    ]);
  });

  test('inviteStatus is derived from expires_at — the API stores no other state', () => {
    expect(inviteStatus(INVITES[0] as InviteInput, NOW)).toBe('pending');
    expect(inviteStatus(INVITES[1] as InviteInput, NOW)).toBe('expired');
  });

  test('inviteRows dims an expired invite', () => {
    const rows = inviteRows(INVITES, NOW);
    expect(rows[0]).toEqual({
      id: 'inv-1',
      label: 'pending@kortix.test',
      right: 'member · pending · 2h',
      dim: false,
    });
    expect(rows[1]?.right).toContain('expired');
    expect(rows[1]?.dim).toBe(true);
  });

  test('roleRows marks a custom role and keeps the description', () => {
    expect(roleRows(ROLES)).toEqual([
      { id: 'builtin:owner', label: 'Owner — Full account control.', right: 'account' },
      { id: 'custom:auditor', label: 'Auditor', right: 'project · custom' },
    ]);
  });

  test('formatCredits keeps a fixed width', () => {
    expect(formatCredits(2)).toBe('2.00');
    expect(formatCredits(0.5)).toBe('0.50');
    expect(formatCredits(Number.NaN)).toBe('—');
  });
});

describe('billingView', () => {
  test('an active account is not blocked', () => {
    const model = billingView(ACTIVE_BILLING);
    expect(model.planLabel).toBe('Free');
    expect(model.state).toBe('active');
    expect(model.blocked).toBe(false);
    expect(model.blockedReason).toBeNull();
    expect(model.credits.total).toBe(2);
  });

  test('out_of_credits is a hard block with its own reason', () => {
    const model = billingView({
      ...ACTIVE_BILLING,
      billing_state: 'out_of_credits',
      credits: { total: 0, daily: 0, monthly: 0, extra: 0, can_run: false },
    });
    expect(model.blocked).toBe(true);
    expect(model.state).toBe('out_of_credits');
    expect(model.blockedReason).toContain('Out of credits');
  });

  test('can_run:false with no billing_state still blocks (older API)', () => {
    const model = billingView({ credits: { total: 0, can_run: false } });
    expect(model.state).toBe('out_of_credits');
    expect(model.blocked).toBe(true);
  });

  test('payment_failed and no_subscription each get their own line', () => {
    expect(billingView({ billing_state: 'payment_failed' }).blockedReason).toContain(
      'Payment failed',
    );
    expect(billingView({ billing_state: 'no_subscription' }).blockedReason).toContain(
      'No subscription',
    );
  });

  test('an unknown state is still treated as a block', () => {
    const model = billingView({ billing_state: 'something_new' });
    expect(model.blocked).toBe(true);
    expect(model.blockedReason).toContain('refuse to start a session');
  });

  test('no state at all reads as "No plan"', () => {
    expect(billingView(null).planLabel).toBe('No plan');
    expect(billingView(undefined).credits.total).toBe(0);
  });
});

describe('<AccountView/> — tabs', () => {
  test('the members tab renders the member rows', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(view(), {
      width: 72,
      height: 16,
    });
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Agent G Org');
    expect(frame).toContain('1 Members');
    expect(frame).toContain('2 Invites');
    expect(frame).toContain('3 Roles');
    expect(frame).toContain('4 Billing');
    expect(frame).toContain('owner@kortix.test');
    expect(frame).toContain('owner · 1h');
    renderer.destroy();
  });

  test('digits and l/h move between tabs', async () => {
    const picked: AccountTab[] = [];
    const { flush, mockInput, renderer } = await testRender(
      view({ onTabChange: (next) => picked.push(next) }),
      { width: 72, height: 16 },
    );
    await flush();
    await act(async () => mockInput.pressKey('2'));
    await flush();
    await act(async () => mockInput.pressKey('4'));
    await flush();
    await act(async () => mockInput.pressKey('l'));
    await flush();
    await act(async () => mockInput.pressKey('h'));
    await flush();
    expect(picked).toEqual(['invites', 'billing', 'invites', 'billing']);
    renderer.destroy();
  });

  test('the invites tab renders pending and expired invites', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(view({ tab: 'invites' }), {
      width: 72,
      height: 16,
    });
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('pending@kortix.test');
    expect(frame).toContain('member · pending');
    expect(frame).toContain('stale@kortix.test');
    expect(frame).toContain('expired');
    expect(frame).toContain('i invite · x cancel');
    renderer.destroy();
  });

  test('an empty invite list says how to add one', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      view({ tab: 'invites', invites: [] }),
      { width: 72, height: 16 },
    );
    await flush();
    expect(captureCharFrame()).toContain('No pending invites. Press i to invite someone.');
    renderer.destroy();
  });

  test('the roles tab is a read-only table', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(view({ tab: 'roles' }), {
      width: 72,
      height: 16,
    });
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Owner — Full account control.');
    expect(frame).toContain('project · custom');
    renderer.destroy();
  });
});

describe('<AccountView/> — billing', () => {
  test('an active account renders the plan and the credits with no banner', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(view({ tab: 'billing' }), {
      width: 72,
      height: 16,
    });
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Plan  Free');
    expect(frame).toContain('Credits  2.00');
    expect(frame).toContain('Tier  free');
    expect(frame).not.toContain('OUT OF CREDITS');
    renderer.destroy();
  });

  test('a hard block renders the danger banner with the state and the reason', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      view({
        tab: 'billing',
        billing: {
          ...ACTIVE_BILLING,
          billing_state: 'out_of_credits',
          credits: { total: 0, daily: 0, monthly: 0, extra: 0, can_run: false },
        },
      }),
      { width: 72, height: 18 },
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('OUT OF CREDITS');
    expect(frame).toContain('Out of credits. Sessions are blocked');
    renderer.destroy();
  });

  test('u prints the web billing URL and never starts a checkout', async () => {
    const toasts: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      view({ tab: 'billing', onToast: (message) => toasts.push(message) }),
      { width: 72, height: 16 },
    );
    await flush();
    await act(async () => mockInput.pressKey('u'));
    await flush();
    expect(toasts).toEqual([
      'Billing lives on the web: https://kortix.com/projects?accountId=acc-1&accountTab=billing',
    ]);
    renderer.destroy();
  });
});

describe('<AccountView/> — invite writes', () => {
  test('i takes the email, then the role, then sends — and the address keeps its letters', async () => {
    const sent: Array<{ email: string; role: string }> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      view({ tab: 'invites', onInvite: (input) => sent.push(input) }),
      { width: 72, height: 18 },
    );
    await flush();
    await act(async () => mockInput.pressKey('i'));
    await flush();
    expect(captureCharFrame()).toContain('Invite email');

    // `kortix` contains the letters `r`, `i` and `x`; every one of them is a
    // screen chord in browse mode. While the `<input>` is focused they must
    // reach the address instead — the regression that split this form in two.
    await act(async () => mockInput.typeText('new@kortix.test'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(captureCharFrame()).toContain('Invite new@kortix.test as');

    await act(async () => mockInput.pressKey('r'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(sent).toEqual([{ email: 'new@kortix.test', role: 'admin' }]);
    renderer.destroy();
  });

  test('the role step cycles both ways and Esc returns to the email step', async () => {
    const sent: Array<{ email: string; role: string }> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      view({ tab: 'invites', onInvite: (input) => sent.push(input) }),
      { width: 72, height: 18 },
    );
    await flush();
    await act(async () => mockInput.pressKey('i'));
    await flush();
    await act(async () => mockInput.typeText('a@b.test'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    await act(async () => mockInput.pressKey('k'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(sent).toEqual([{ email: 'a@b.test', role: 'owner' }]);
    expect(captureCharFrame()).not.toContain('Invite a@b.test as');
    renderer.destroy();
  });

  test('x asks before cancelling, and y cancels the selected invite', async () => {
    const cancelled: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      view({ tab: 'invites', onCancelInvite: (id) => cancelled.push(id) }),
      { width: 72, height: 18 },
    );
    await flush();
    await act(async () => mockInput.pressKey('x'));
    await flush();
    expect(captureCharFrame()).toContain('Cancel the invite for pending@kortix.test?');
    expect(cancelled).toEqual([]);
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(cancelled).toEqual(['inv-1']);
    renderer.destroy();
  });

  test('n declines the cancel', async () => {
    const cancelled: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      view({ tab: 'invites', onCancelInvite: (id) => cancelled.push(id) }),
      { width: 72, height: 18 },
    );
    await flush();
    await act(async () => mockInput.pressKey('x'));
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    expect(cancelled).toEqual([]);
    expect(captureCharFrame()).not.toContain('Cancel the invite for');
    renderer.destroy();
  });

  test('x on a build with no cancel says so instead of pretending', async () => {
    const toasts: Array<[string, string | undefined]> = [];
    const { flush, mockInput, renderer } = await testRender(
      view({
        tab: 'invites',
        canCancelInvite: false,
        onToast: (message, kind) => toasts.push([message, kind]),
      }),
      { width: 72, height: 18 },
    );
    await flush();
    await act(async () => mockInput.pressKey('x'));
    await flush();
    expect(toasts).toEqual([['This SDK build exposes no invite cancel.', 'error']]);
    renderer.destroy();
  });

  test('j moves the cursor so x targets the second invite', async () => {
    const cancelled: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      view({ tab: 'invites', onCancelInvite: (id) => cancelled.push(id) }),
      { width: 72, height: 18 },
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressKey('x'));
    await flush();
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(cancelled).toEqual(['inv-2']);
    renderer.destroy();
  });

  test('an unfocused screen ignores every key', async () => {
    const picked: AccountTab[] = [];
    const { flush, mockInput, renderer } = await testRender(
      view({ focused: false, onTabChange: (next) => picked.push(next) }),
      { width: 72, height: 16 },
    );
    await flush();
    await act(async () => mockInput.pressKey('2'));
    await flush();
    expect(picked).toEqual([]);
    renderer.destroy();
  });

  test('the SDK error message for the active tab is rendered verbatim', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      view({ members: [], errorMessage: 'HTTP 403: account.members.read' }),
      { width: 72, height: 16 },
    );
    await flush();
    expect(captureCharFrame()).toContain('HTTP 403: account.members.read');
    renderer.destroy();
  });
});
