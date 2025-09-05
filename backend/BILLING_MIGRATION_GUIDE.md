# Billing System Migration Guide

## Overview
This guide covers the migration from the complex usage-based billing to a simplified credit-based system.

## Key Changes

### Before (Old System)
- Monthly usage calculation against tier limits
- Complex overage handling with separate credit purchases
- Race conditions in token tracking
- No admin controls for disputes

### After (New System)
- Simple credit balance per user
- Atomic credit deductions
- Full admin panel for credit management
- Complete audit trail

## Migration Steps

### 1. Deploy Database Migrations

Run migrations in order:
```bash
# From backend directory
supabase migration up 20250115000001_user_roles_system.sql
supabase migration up 20250115000002_credit_system_refactor.sql
supabase migration up 20250115000003_admin_actions_log.sql
```

### 2. Deploy Backend Code

The new system runs alongside the old one during migration:
- Old endpoints: `/api/billing/*`
- New endpoints: `/api/billing/v2/*`
- Admin endpoints: `/api/admin/billing/*`

### 3. Run Migration Script

Test with dry run first:
```bash
python scripts/migrate_to_credits.py --dry-run
```

Then run actual migration:
```bash
python scripts/migrate_to_credits.py
```

### 4. Set Up Cron Jobs

Add to your cron configuration:
```cron
# Grant monthly credits at midnight on the 1st
0 0 1 * * cd /path/to/backend && python -m core.cron_jobs
```

### 5. Update Frontend

Switch API calls from old to new endpoints:
```javascript
// Old
await fetch('/api/billing/check')

// New
await fetch('/api/billing/v2/check')
```

## Admin Panel Usage

### Grant Credits to User
```bash
curl -X POST /api/admin/billing/credits/adjust \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "user_id": "uuid",
    "amount": 50.00,
    "reason": "Customer complaint resolution"
  }'
```

### Process Refund
```bash
curl -X POST /api/admin/billing/refund \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN" \
  -d '{
    "user_id": "uuid",
    "amount": 25.00,
    "reason": "Service outage compensation",
    "stripe_refund": true,
    "payment_intent_id": "pi_xxx"
  }'
```

### View User Billing History
```bash
curl /api/admin/billing/user/{user_id}/summary \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Configuration

Edit `core/billing_config.py` to adjust:

### Tier Credits
```python
TIERS = {
    'tier_2_20': {
        'monthly_credits': Decimal('25.00'),  # Adjust this
        ...
    }
}
```

### Admin Limits
```python
ADMIN_LIMITS = {
    'regular_admin': {
        'max_credit_adjustment': Decimal('1000'),  # Adjust this
        ...
    }
}
```

## Rollback Plan

If issues arise, rollback is safe:

1. Switch frontend back to old endpoints
2. Old billing system remains functional
3. Run rollback for specific users:
```python
from scripts.migrate_to_credits import CreditMigration
migration = CreditMigration()
await migration.rollback_user('user_id')
```

## Monitoring

### Key Metrics to Watch
- Credit balance going negative (should never happen)
- Failed credit deductions
- Webhook processing errors
- Admin action frequency

### Alerts to Set Up
```sql
-- Alert on negative balances
SELECT * FROM credit_accounts WHERE balance < 0;

-- Alert on failed deductions in last hour
SELECT COUNT(*) FROM credit_ledger 
WHERE type = 'usage' 
AND created_at > NOW() - INTERVAL '1 hour'
AND amount = 0;
```

## FAQ

### Q: What happens to existing credit purchases?
A: They are migrated to the new credit_accounts table with full history preserved.

### Q: Can users still purchase credits?
A: Yes, but only users on the highest tier ($1000/month) can purchase additional credits.

### Q: How are refunds handled?
A: Super admins can issue credit refunds and optionally process Stripe refunds.

### Q: What about yearly subscriptions?
A: They receive the same monthly credit allocation as monthly plans.

## Support

For issues during migration:
1. Check logs in `backend/logs/migration.log`
2. Run analysis: `python scripts/migrate_to_credits.py --analyze`
3. Contact backend team with user_id and error details 