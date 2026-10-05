/**
 * Live harness for `features/account` (wave 2). Not a unit test — it needs a
 * real API and a real token, so `bun test` never runs it.
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt-or-pat> \
 *   bun run scripts/dev-account.tsx
 *
 * `--interactive` drives it in this terminal (Ctrl+C quits).
 * `--invite` additionally sends a REAL invite to `KORTIX_INVITE_EMAIL` (default
 * a `@kortix.test` address) and then cancels it, so the Invites tab is proved
 * with a real row rather than an empty state. It is off by default so a re-run
 * costs nothing and sends no mail.
 *
 * `KORTIX_ACCOUNT_ID` pins the account; without it the harness takes the first
 * account the token can see.
 */

import { createCliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { resolveHost } from '../src/auth/hosts.ts';
import { AccountScreen, billingWebUrl } from '../src/features/account/index.ts';
import { initKortix, kortix } from '../src/kortix.ts';

const INTERACTIVE = process.argv.includes('--interactive');
const ALLOW_INVITE = process.argv.includes('--invite');
const WIDTH = 90;
const HEIGHT = Number(process.env.ACCOUNT_HEIGHT ?? 22);

const host = resolveHost();
if (!host) throw new Error('no host: set KORTIX_API_URL + KORTIX_API_KEY');
initKortix(host);

const accounts = await kortix().accounts.list();
const accountId = process.env.KORTIX_ACCOUNT_ID?.trim() || accounts[0]?.account_id;
if (!accountId) throw new Error('no account visible to this token');
const account = accounts.find((entry) => entry.account_id === accountId);
console.log(
  `host=${host.backendUrl} account=${accountId} (${account?.name ?? '?'}) role=${account?.account_role ?? '?'}`,
);
console.log(`billing URL the screen prints on u: ${billingWebUrl(host.backendUrl, accountId)}`);

const inviteEmail =
  process.env.KORTIX_INVITE_EMAIL?.trim() || `tui-invite-${Date.now()}@kortix.test`;

function banner(title: string): void {
  console.log(`\n===== ${new Date().toISOString().slice(11, 19)} ${title} =====`);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const toasts: string[] = [];

function Harness() {
  return (
    <QueryClientProvider client={queryClient}>
      <AccountScreen
        accountId={accountId as string}
        focused
        width={WIDTH}
        height={HEIGHT}
        onBack={() => console.log('[onBack]')}
        onToast={(message, kind) => {
          toasts.push(`${kind ?? 'info'}: ${message}`);
          console.log(`[toast/${kind ?? 'info'}] ${message}`);
        }}
      />
    </QueryClientProvider>
  );
}

if (INTERACTIVE) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(<Harness />);
} else {
  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const root = createRoot(setup.renderer);
  root.render(<Harness />);

  const settle = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await setup.renderOnce();
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  const frame = () => setup.captureCharFrame();
  const press = async (key: string, ms = 300) => {
    setup.mockInput.pressKey(key);
    await settle(ms);
  };

  // The four reads, straight from the SDK, so every frame assertion has a
  // baseline that does not depend on what was rendered.
  const [members, invites, roles, billing] = await Promise.all([
    kortix().accounts.members(accountId as string),
    kortix().accounts.invites(accountId as string),
    kortix().iam.roles.list(accountId as string),
    kortix().billing.accountState({ accountId: accountId as string }),
  ]);
  console.log(
    `API: members=${members.length} invites=${invites.length} roles=${roles.length} billing_state=${billing.billing_state} credits=${billing.credits.total} plan=${billing.plan?.label}`,
  );

  await settle(4000);
  banner('FRAME 1 — Members, live');
  console.log(frame());

  await press('2');
  banner('FRAME 2 — Invites, live');
  console.log(frame());

  await press('3');
  banner('FRAME 3 — Roles, live (read-only)');
  console.log(frame());

  await press('4');
  banner('FRAME 4 — Billing, live');
  console.log(frame());

  await press('u');
  console.log(`toast after u: ${JSON.stringify(toasts.at(-1))}`);

  if (ALLOW_INVITE) {
    banner(`INVITE — sending a real invite to ${inviteEmail}`);
    await press('2');
    await press('i');
    await setup.mockInput.typeText(inviteEmail, 2);
    await settle(300);
    console.log(frame());
    setup.mockInput.pressEnter();
    await settle(400);
    banner('FRAME 5 — the role step');
    console.log(frame());
    setup.mockInput.pressEnter();
    await settle(8000);
    banner('FRAME 6 — the invite list after a real POST /accounts/:id/members');
    console.log(frame());

    const readBack = await kortix().accounts.invites(accountId as string);
    const created = readBack.find((entry) => entry.email === inviteEmail);
    console.log(
      `read-back: ${readBack.length} invites, created=${created ? created.invite_id : 'NOT FOUND'} role=${created?.initial_role}`,
    );
    if (!created) throw new Error('the invite did not land');

    banner('CANCEL — x then y on that row');
    await press('x');
    console.log(frame());
    await press('y');
    await settle(8000);
    const afterCancel = await kortix().accounts.invites(accountId as string);
    console.log(
      `read-back after cancel: ${afterCancel.length} invites, still listed=${afterCancel.some((e) => e.email === inviteEmail)}`,
    );
    banner('FRAME 7 — after the cancel');
    console.log(frame());
  }

  banner('SUMMARY');
  console.log(
    JSON.stringify(
      {
        members: members.length,
        invites: invites.length,
        roles: roles.length,
        billingState: billing.billing_state,
        credits: billing.credits.total,
        toasts,
      },
      null,
      2,
    ),
  );

  root.unmount();
  setup.renderer.destroy();
  process.exit(0);
}
