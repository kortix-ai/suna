# Admin Panel Handoff

## Current shape

- `/admin` is now the single standalone admin dashboard.
- It uses one internal section switcher instead of treating admin as multiple separate dashboard-shell tabs.
- Sections currently available:
  - `instances`
  - `accounts`
  - `access-requests`

## Main frontend files

- `apps/web/src/app/admin/page.tsx`
  - standalone admin dashboard shell
  - reads `?section=` and swaps sections in-place
- `apps/web/src/components/admin/admin-dashboard-sections.tsx`
  - contains the actual section UIs:
    - `AdminInstancesSection`
    - `AdminAccountsSection`
    - `AdminAccessRequestsSection`
- `apps/web/src/app/instances/_components/instance-settings-modal.tsx`
  - shared instance management modal used for both normal users and admins
- `apps/web/src/app/instances/page.tsx`
  - normal user instances page
  - Admin Console button should go to `/admin`
- `apps/web/src/components/settings/user-settings-modal.tsx`
  - has admin shortcuts in the General tab

## Backend/admin API added or used

- `apps/api/src/admin/index.ts`
  - `GET /v1/admin/api/accounts`
  - `GET /v1/admin/api/accounts/:id/users`
  - `POST /v1/admin/api/accounts/:id/credits`
  - existing sandbox admin APIs are still used for admin fleet management

## Instance management modal state

- Old per-card actions were collapsed into one settings modal.
- Current tabs:
  - `General`
  - `Host`
  - `Updates`
  - `Backups`
- Host tab now includes:
  - host actions
  - SSH/setup command copy UX
  - resource usage + capacity context
  - deep debugging notes

## Known UX cleanup opportunities

1. Make `/admin` feel more polished visually
   - better section switcher styling
   - persistent summary counts/cards
   - cleaner empty/loading states

2. Tighten admin instances table UX
   - better visual hierarchy for account/email/provider/status
   - maybe sticky filters/header

3. Tighten admin accounts UX
   - ledger/history
   - debit/remove credits
   - reimbursement presets
   - subscription controls

4. Continue simplifying navigation
   - all admin entry points should land on `/admin`
   - sections should switch inside `/admin`

## Important note

There are unrelated working tree changes outside the admin/instance-management scope (for example provider config files/tests). They were intentionally not part of this handoff scope.
