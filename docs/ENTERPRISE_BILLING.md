# Enterprise Billing System

## Overview

The enterprise billing system provides a simplified credit-based billing solution for enterprise deployments. When enabled, **ALL users share a single credit pool** and have individual monthly spending limits.

## Key Features

- **Single Credit Pool**: All users draw from one enterprise credit balance
- **Per-User Limits**: Each user has a configurable monthly spending limit
- **Manual Credit Loading**: Admins load credits manually (no Stripe integration)
- **Full Model Access**: All users get access to all AI models (highest tier)
- **Usage Tracking**: Detailed usage logs per user for transparency
- **Simple Admin Interface**: Web-based admin panel for management

## How It Works

### When ENTERPRISE_MODE is Enabled

1. **ALL users are enterprise users** - no separate account types
2. **Single billing account** with ID `00000000-0000-0000-0000-000000000000`
3. **No Stripe integration** - billing is completely managed internally
4. **Credits are shared** - all users draw from the same pool
5. **Monthly limits per user** - default $1000/month, configurable per user

### Architecture

```
┌─────────────────┐
│ Enterprise      │
│ Credit Pool     │
│ $10,000         │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
┌───▼───┐ ┌──▼────┐
│User A │ │User B │
│$1000  │ │$500   │
│limit  │ │limit  │
└───────┘ └───────┘
```

## Setup Instructions

### 1. Environment Variables

Set these in your backend deployment:

```bash
# Enable enterprise mode
ENTERPRISE_MODE=true

# Admin emails (comma-separated)
ADMIN_EMAILS=admin@company.com,billing@company.com
```

### 2. Database Migration

Run the migration to create enterprise billing tables:

```bash
# The migration file: backend/supabase/migrations/20250106000000_simplify_enterprise_billing.sql
# Run via your Supabase dashboard or CLI
```

### 3. Initial Credit Load

1. Login with an admin email
2. Navigate to `/admin` in the frontend
3. Click "Load Credits"
4. Enter the amount (e.g., $10,000)
5. Credits are now available for all users

## Admin Functions

### Admin Dashboard (`/admin`)

The admin dashboard provides:

- **Overview**: Total credits, users, usage
- **User Management**: View all users and their usage
- **Credit Loading**: Add credits to the pool
- **Limit Setting**: Configure per-user monthly limits
- **Usage Details**: Drill down into individual user usage

### API Endpoints

#### Admin Endpoints (require admin email):
- `GET /api/enterprise/status` - Overall enterprise status
- `POST /api/enterprise/load-credits` - Load credits
- `GET /api/enterprise/users` - List all users with usage
- `GET /api/enterprise/users/{id}` - User details
- `POST /api/enterprise/users/{id}/limit` - Set user limit

#### User-Facing Endpoints (automatic):
- `GET /api/billing/subscription` - Shows enterprise "subscription"
- `GET /api/billing/check-status` - Checks if user can run agents
- `GET /api/billing/usage-logs` - User's own usage logs

## User Experience

### What Users See

1. **Billing Page**: Shows "Enterprise" plan with their monthly limit and usage
2. **Usage Logs**: Their individual usage history
3. **Model Access**: All AI models available
4. **No Payment Options**: Checkout/portal buttons hidden

### How It Works for Users

1. User runs an agent
2. System checks:
   - Is there enterprise credit balance?
   - Is user under their monthly limit?
3. If both pass, agent runs
4. Usage is deducted from:
   - Enterprise credit pool
   - User's monthly usage counter
5. User sees updated usage in their dashboard

## Technical Details

### Database Schema

```sql
-- Single enterprise billing account
enterprise_billing (
    id: UUID (fixed: 00000000-0000-0000-0000-000000000000)
    credit_balance: DECIMAL
    total_loaded: DECIMAL
    total_used: DECIMAL
)

-- Per-user limits
enterprise_user_limits (
    account_id: UUID (FK to accounts)
    monthly_limit: DECIMAL (default: 1000.00)
    current_month_usage: DECIMAL
    is_active: BOOLEAN
)

-- Usage tracking
enterprise_usage (
    account_id: UUID
    cost: DECIMAL
    model_name: VARCHAR
    created_at: TIMESTAMP
)
```

### Service Architecture

```
billing_wrapper.py
    ├── If ENTERPRISE_MODE=true
    │   └── enterprise_billing.py (all users)
    └── If ENTERPRISE_MODE=false
        └── billing.py (Stripe)
```

### Key Functions

- `check_billing_status()` - Returns enterprise limits instead of Stripe subscription
- `use_enterprise_credits()` - Deducts from shared pool with per-user limit check
- `load_credits()` - Admin function to add credits
- `set_user_limit()` - Admin function to set monthly limit

## Monthly Reset

User monthly usage counters reset automatically on the 1st of each month. This can also be triggered manually by admins via the API.

## Monitoring

### Usage Patterns
- Monitor total enterprise balance
- Track per-user usage trends
- Identify heavy users
- Predict when to load more credits

### Alerts (Recommended)
- Low balance warning (< $100)
- User approaching limit (> 90%)
- Unusual usage spike detection

## FAQ

**Q: What happens when credits run out?**
A: Users cannot run agents until admin loads more credits.

**Q: Can users purchase their own credits?**
A: No, only admins can load credits for the enterprise.

**Q: What if a user exceeds their monthly limit?**
A: They cannot run agents until the next month or limit increase.

**Q: How are costs calculated?**
A: Same as normal billing - based on token usage and model pricing.

**Q: Can we have different tiers of users?**
A: Yes, through different monthly limits per user.

## Troubleshooting

### Users Can't Run Agents
1. Check enterprise credit balance
2. Check user's monthly limit and usage
3. Verify ENTERPRISE_MODE=true
4. Check database migration was run

### Admin Can't Access Dashboard
1. Verify email is in ADMIN_EMAILS
2. Check environment variable is set correctly
3. Ensure backend was restarted after config change

### Credits Not Deducting
1. Check billing_wrapper is being used
2. Verify database functions exist
3. Check error logs for details

## Best Practices

1. **Regular Monitoring**: Check balance weekly
2. **Proactive Loading**: Load credits before running out
3. **Usage Reviews**: Monthly review of user usage patterns
4. **Limit Adjustments**: Adjust limits based on actual usage
5. **Communication**: Notify users of their limits and usage
