---
title: Email channel cost pass-through (Resend Inboxes)
status: parked
owner: unassigned
updated: 2026-10-24
---

# Email channel cost pass-through

## Problem

The managed email channel creates one Resend Inbox per project that connects
email (`name@kortixmail.com`, Kortix's Resend team, `RESEND_API_KEY`). Resend
bills per inbox and per email, and Kortix pays both today. No meter attributes
that usage to the project or account that caused it, so billing cannot pass it on.

How Resend bills it, as read on 2026-10-24 (resend.com/pricing):

- Every plan includes 3 inboxes. Each further inbox is a monthly charge with
  pay-as-you-go turned on.
- Inbox emails (sent and received) count against the plan's email quota, then
  a per-email charge.

A project that connects its own Resend key pays Resend directly. It costs
Kortix nothing and needs no meter.

## Decision so far

2026-10-24: managed email uses Resend Inboxes, not catch-all Receiving. Inboxes
give a real mailbox (threads, search, history the agent can list) that
Receiving would make Kortix build and store itself. The per-inbox cost is
accepted for projects that connect managed email.

2026-10-24, later: "Your Resend account" (own API key) is the primary path in
the connect form, CLI and docs. Managed email is an operator switch,
`RESEND_MANAGED_EMAIL_ENABLED`, not a project flag: a project admin can turn
project flags on, and would then create inboxes Kortix pays for. Turning the
env off stops new managed inboxes, which is the lever if the cost is not passed
on. The whole email channel is behind the project flag `email_channel` (off by
default) while it is experimental.

## What a meter needs

1. Inbox-months: one per managed inbox per month it exists (created and deleted
   timestamps from the email install).
2. Emails: count sent and received per managed inbox (the inbound webhook and
   the reply/send actions already pass through the API).
3. Attribution: inbox → project → account, from `chat_installs` (platform
   `email`, workspace id = Resend inbox id).
4. Then a billing decision: include N managed inboxes per plan, or charge
   through credits. Load the `billing` skill before designing it.

## Pick it up

- Install and routes: `apps/api/src/projects/routes/channel-email.ts`,
  `apps/api/src/channels/email/`.
- Billing: the `billing` skill (credits, wallet, plans).
