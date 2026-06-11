Mobile app v2 (account management, files, terminal) + team billing fixes

## Mobile app v2
Full account-management parity with web: members, invites, groups, roles, audit log (filters, diffs, CSV/JSONL export), tokens (PATs + service accounts), security (MFA, session controls), observability webhooks, and Git installations — all native. Plus a rebuilt Files page (create/edit/save, classic UI), Terminal + Browser side-panel tabs with a real ANSI PTY renderer, session menu parity (rename/share/delete/restart), per-project tab memory, offline boot fixes, and a broad visual polish pass (borderless lists, bottom sheets, skeleton loaders, haptics).

## Team billing fixes
- Upgrade/subscribe flow is now scoped to the project's account, not the viewer's primary account (fixes per-seat checkout charging the wrong account)
- Checkout/subscribe gated behind billing.write; Billing shortcut hidden for non-billable users
- Subscribe modal shows the live projected seat total
- Newly-joined invitees land on /projects instead of account settings

## Web
- Delete-session dialog clarifies the branch is preserved
