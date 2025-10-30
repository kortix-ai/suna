# GDPR Account Deletion Feature

This document describes the implementation of the GDPR-compliant account deletion feature.

## Overview

The account deletion feature allows users to request permanent deletion of their account and all associated data, with a 30-day grace period for recovery.

## Architecture

### Database Layer

**Migration:** `backend/supabase/migrations/20251030130000_account_deletion_gdpr.sql`

#### Tables

1. **account_deletion_requests**
   - `id`: UUID primary key
   - `account_id`: Reference to basejump.accounts
   - `user_id`: Reference to auth.users
   - `requested_at`: Timestamp when deletion was requested
   - `deletion_scheduled_for`: Timestamp when deletion will occur (requested_at + 30 days)
   - `reason`: Optional reason for deletion
   - `is_cancelled`: Boolean flag for cancelled requests
   - `cancelled_at`: Timestamp when request was cancelled
   - `is_deleted`: Boolean flag for completed deletions
   - `deleted_at`: Timestamp when deletion was completed

#### Functions

1. **delete_user_data(p_account_id UUID, p_user_id UUID)**
   - Deletes all user data across all tables
   - Tables deleted in order:
     - messages
     - threads
     - agent_runs
     - agent_versions
     - agents
     - projects
     - user_mcp_credentials
     - agent_templates
     - knowledge_bases
     - devices
     - api_keys
     - google_oauth_tokens
     - credit_grants
     - credit_ledger
     - credit_accounts
     - basejump.billing_subscriptions
     - basejump.billing_customers
     - basejump.account_user
     - account_deletion_requests
     - basejump.accounts
   - Returns TRUE on success, FALSE on failure
   - Uses SECURITY DEFINER for elevated permissions

2. **process_scheduled_account_deletions()**
   - Runs daily via Supabase Cron at 2:00 AM
   - Finds all deletion requests where `deletion_scheduled_for <= NOW()`
   - Calls `delete_user_data()` for each account
   - Updates the request status to `is_deleted = TRUE`

#### Cron Job

- **Name:** `process-account-deletions`
- **Schedule:** Daily at 2:00 AM (`0 2 * * *`)
- **Action:** Executes `process_scheduled_account_deletions()`

### Backend API

**File:** `backend/core/account_deletion.py`

#### Endpoints

1. **POST /api/account/request-deletion**
   - Request account deletion
   - Body: `{ "reason": "optional string" }`
   - Response: Deletion scheduled date and confirmation message
   - Sets `deletion_scheduled_for` to 30 days from now
   - Idempotent: Returns existing request if one already exists

2. **POST /api/account/cancel-deletion**
   - Cancel a pending deletion request
   - No body required
   - Response: Confirmation message
   - Sets `is_cancelled = TRUE` on the deletion request

3. **GET /api/account/deletion-status**
   - Check if account has a pending deletion
   - Response: Status object with deletion date if applicable

4. **DELETE /api/account/delete-immediately** (Admin/Testing)
   - Immediately delete account without grace period
   - Calls `delete_user_data()` directly
   - Also deletes the user from Supabase Auth using Admin API

### Frontend UI

**File:** `frontend/src/components/settings/user-settings-modal.tsx`

#### Features

1. **Danger Zone Section**
   - Located in General tab of settings modal
   - Only visible when not in local mode

2. **Delete Account Button**
   - Opens confirmation dialog
   - Lists all data that will be deleted
   - Explains the 30-day grace period

3. **Deletion Scheduled Alert**
   - Shows when deletion is scheduled
   - Displays the deletion date
   - Provides button to cancel deletion

4. **Cancel Deletion Dialog**
   - Confirms cancellation of deletion request
   - Restores account to normal state

## User Flow

### Request Deletion

1. User opens Settings > General tab
2. Scrolls to "Danger Zone" section
3. Clicks "Delete Account" button
4. Reviews deletion confirmation dialog
5. Confirms deletion
6. Account is scheduled for deletion in 30 days
7. User sees alert showing deletion date

### Cancel Deletion (Recovery)

1. User opens Settings > General tab
2. Sees "Account Deletion Scheduled" alert
3. Clicks "Cancel Deletion" button
4. Confirms cancellation
5. Account returns to normal state

### Automatic Deletion

1. Cron job runs daily at 2:00 AM
2. Finds accounts with `deletion_scheduled_for <= NOW()`
3. For each account:
   - Calls `delete_user_data()`
   - Deletes all user data from all tables
   - Marks deletion request as complete
4. User is logged out automatically
5. Account and all data are permanently deleted

## Data Deleted

When an account is deleted, the following data is permanently removed:

1. **Agent Data**
   - All agents created by the user
   - All agent versions
   - Agent runs and execution history

2. **Conversation Data**
   - All threads
   - All messages in threads
   - Thread metadata

3. **Integration Data**
   - MCP credentials
   - API keys
   - Google OAuth tokens
   - Credential profiles

4. **Content Data**
   - Knowledge bases
   - Agent templates
   - File uploads

5. **Billing Data**
   - Credit accounts
   - Credit ledger
   - Credit grants
   - Billing subscriptions
   - Billing customers

6. **Account Data**
   - Account record
   - Account user relationships
   - Projects
   - Devices

7. **Auth Data** (for immediate deletion)
   - Supabase Auth user record

## Security

- All deletion functions use `SECURITY DEFINER` for proper permissions
- RLS policies protect deletion requests to user's own account only
- Service role required for actual deletion operations
- Deletion requests are tied to both account_id and user_id for verification

## GDPR Compliance

This implementation complies with GDPR requirements:

1. **Right to Erasure (Article 17):**
   - Users can request deletion of their personal data
   - All data is permanently deleted after 30 days

2. **Grace Period:**
   - 30-day window allows users to recover from accidental deletion
   - Users can cancel deletion anytime during this period

3. **Complete Data Deletion:**
   - All personal and associated data is deleted
   - No data is retained after deletion

4. **Transparency:**
   - Users are informed about what data will be deleted
   - Clear timeline is provided (30 days)

## Testing

### Manual Testing

1. **Request Deletion:**
   ```bash
   curl -X POST https://your-api.com/api/account/request-deletion \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"reason": "Testing deletion"}'
   ```

2. **Check Status:**
   ```bash
   curl https://your-api.com/api/account/deletion-status \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

3. **Cancel Deletion:**
   ```bash
   curl -X POST https://your-api.com/api/account/cancel-deletion \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

4. **Immediate Deletion (Testing):**
   ```bash
   curl -X DELETE https://your-api.com/api/account/delete-immediately \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

### Database Testing

1. **Test Cron Job Manually:**
   ```sql
   SELECT process_scheduled_account_deletions();
   ```

2. **Check Deletion Requests:**
   ```sql
   SELECT * FROM account_deletion_requests;
   ```

3. **Test Delete Function:**
   ```sql
   SELECT delete_user_data('account-uuid', 'user-uuid');
   ```

## Deployment

1. **Apply Migration:**
   ```bash
   # Migration will be applied automatically by Supabase
   # Or manually run:
   psql -f backend/supabase/migrations/20251030130000_account_deletion_gdpr.sql
   ```

2. **Verify Cron Job:**
   ```sql
   SELECT * FROM cron.job WHERE jobname = 'process-account-deletions';
   ```

3. **Deploy Backend:**
   - Ensure `backend/core/account_deletion.py` is included
   - Verify router is registered in `backend/core/api.py`

4. **Deploy Frontend:**
   - Ensure settings modal changes are deployed
   - Verify API URL is configured correctly

## Monitoring

Monitor the following:

1. **Cron Job Execution:**
   ```sql
   SELECT * FROM cron.job_run_details 
   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'process-account-deletions')
   ORDER BY start_time DESC;
   ```

2. **Deletion Requests:**
   ```sql
   SELECT 
     COUNT(*) FILTER (WHERE is_cancelled = FALSE AND is_deleted = FALSE) as pending,
     COUNT(*) FILTER (WHERE is_cancelled = TRUE) as cancelled,
     COUNT(*) FILTER (WHERE is_deleted = TRUE) as completed
   FROM account_deletion_requests;
   ```

3. **Failed Deletions:**
   - Check logs for errors in `delete_user_data()` function
   - Monitor for deletion requests that remain pending past their scheduled date

## Notes

- The Supabase Auth user deletion in `delete_account_immediately()` requires the `SUPABASE_SERVICE_KEY` environment variable
- The cron job runs at 2:00 AM by default - adjust if needed
- Consider adding email notifications when deletion is scheduled/completed
- Consider adding data export feature before deletion (GDPR right to data portability)

