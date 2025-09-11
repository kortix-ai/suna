# Enterprise Tool Tracking Integration

This document explains how to integrate individual tool tracking into enterprise mode, making it behave similarly to the regular (non-enterprise) billing mode.

## Overview

Previously, enterprise mode only tracked LLM token costs while individual tool usage was covered by the overall enterprise credit system without specific tracking. This integration adds individual tool cost tracking and billing to enterprise accounts, providing detailed analytics and cost control.

## Features

### Before Integration
- ✅ Enterprise users shared one credit pool
- ✅ LLM token usage was tracked and charged
- ❌ Tool usage was not individually tracked or charged
- ❌ No tool-specific analytics or cost breakdown

### After Integration
- ✅ Enterprise users share one credit pool
- ✅ LLM token usage tracked and charged (unchanged)
- ✅ **Individual tool usage tracked and charged**
- ✅ **Tool-specific analytics and cost breakdown**
- ✅ **Per-user monthly limits include tool costs**
- ✅ **Pre-execution tool affordability checks**

## Database Changes

### 1. Extended Enterprise Usage Table

The `enterprise_usage` table now includes tool-specific fields:

```sql
ALTER TABLE public.enterprise_usage 
ADD COLUMN tool_name VARCHAR(255),
ADD COLUMN tool_cost DECIMAL(10, 6) DEFAULT 0,
ADD COLUMN usage_type VARCHAR(50) DEFAULT 'token' CHECK (usage_type IN ('token', 'tool'));
```

### 2. New Database Functions

#### `enterprise_can_use_tool(account_id, tool_name)`
- Checks if user can afford a specific tool
- Validates against user monthly limits and enterprise balance
- Returns: `can_use`, `required_cost`, `current_balance`, `user_remaining`

#### `enterprise_use_tool_credits(account_id, tool_name, thread_id, message_id)`
- Charges tool cost from enterprise credits
- Updates user monthly usage
- Logs tool usage separately
- Returns: `success`, `cost_charged`, `new_balance`, `user_remaining`

### 3. Analytics View

`enterprise_tool_usage_analytics` provides detailed tool usage reporting:

```sql
SELECT 
    account_id, tool_name, tool_cost, created_at,
    usage_date, usage_hour, usage_month
FROM enterprise_usage 
WHERE usage_type = 'tool';
```

## API Changes

### Updated Billing Wrapper Functions

#### `can_user_afford_tool_unified()`
- **Before**: Always returned `can_use: True, required_cost: 0.0` for enterprise
- **After**: Calls `enterprise_can_use_tool()` to check individual tool costs

#### `charge_tool_usage_unified()`
- **Before**: Always returned `success: True, cost_charged: 0.0` for enterprise  
- **After**: Calls `enterprise_use_tool_credits()` to charge actual tool costs

### New Enterprise Service Methods

#### `enterprise_billing.can_user_afford_tool(account_id, tool_name)`
```python
result = await enterprise_billing.can_user_afford_tool(
    account_id="user-uuid", 
    tool_name="browser_screenshot"
)
# Returns: {'can_use': bool, 'required_cost': float, 'current_balance': float, 'user_remaining': float}
```

#### `enterprise_billing.charge_tool_usage(account_id, tool_name, thread_id, message_id)`
```python
result = await enterprise_billing.charge_tool_usage(
    account_id="user-uuid",
    tool_name="browser_screenshot", 
    thread_id="thread-uuid",
    message_id="msg-uuid"
)
# Returns: {'success': bool, 'cost_charged': float, 'new_balance': float, 'user_remaining': float}
```

#### `enterprise_billing.get_tool_usage_analytics(account_id, days, page, items_per_page)`
```python
analytics = await enterprise_billing.get_tool_usage_analytics(
    account_id="user-uuid",
    days=30,
    page=0, 
    items_per_page=100
)
# Returns detailed tool usage data with costs and timestamps
```

### New API Endpoint

#### `GET /enterprise-billing/tool-usage-analytics`
```http
GET /enterprise-billing/tool-usage-analytics?days=30&page=0&items_per_page=100
Authorization: Bearer <jwt-token>
```

Response:
```json
{
    "tool_usage": [
        {
            "account_id": "uuid",
            "tool_name": "browser_screenshot", 
            "tool_cost": 0.05,
            "created_at": "2025-01-20T10:00:00Z",
            "usage_date": "2025-01-20",
            "thread_id": "thread-uuid",
            "message_id": "msg-uuid"
        }
    ],
    "total_logs": 150,
    "total_cost_period": 7.50,
    "period_days": 30
}
```

## Tool Cost Configuration

Tool costs are defined in the `tool_costs` table (shared between enterprise and regular mode):

```sql
INSERT INTO tool_costs (tool_name, cost_dollars, description) VALUES 
    ('browser_screenshot', 0.05, 'Take screenshot of webpage'),
    ('navigate_to_url', 0.02, 'Navigate browser to URL'),
    ('web_search', 0.03, 'Web search query'),
    ('api_request', 0.10, 'External API request');
```

## Usage Flow

### 1. Tool Execution Request
```python
# Agent wants to use browser_screenshot tool
tool_name = "browser_screenshot"
account_id = "user-uuid"
```

### 2. Pre-execution Check
```python
# Check if user can afford the tool
affordability = await can_user_afford_tool_unified(client, account_id, tool_name)

if not affordability['can_use']:
    return ToolResult(
        success=False,
        output=f"Insufficient credits. Required: ${affordability['required_cost']}, Available: ${affordability['current_balance']}"
    )
```

### 3. Tool Execution
```python
# Execute the tool (browser screenshot, etc.)
result = await execute_tool(tool_name, arguments)
```

### 4. Post-execution Charging
```python
# Charge for successful tool usage
if result.success:
    charge_result = await charge_tool_usage_unified(
        client, account_id, tool_name, thread_id, message_id
    )
    
    if charge_result['success']:
        logger.info(f"Charged ${charge_result['cost_charged']} for {tool_name}")
```

## Deployment Steps

### 1. Run Database Migration
```bash
# Apply the new migration
psql -h your-db-host -d your-db -f backend/supabase/migrations/20250908204914_enterprise_tool_tracking.sql
```

### 2. Deploy Backend Changes
- Deploy updated `billing_wrapper.py`
- Deploy updated `enterprise_billing.py` 
- Deploy updated `enterprise_billing_api.py`

### 3. Verify Integration
```bash
# Test tool affordability check
curl -H "Authorization: Bearer <token>" \
  "https://api.your-domain.com/enterprise-billing/tool-usage-analytics"
```

## Monitoring & Analytics

### Usage Tracking
- All tool usage is logged in `enterprise_usage` table with `usage_type='tool'`
- Token usage continues to be logged with `usage_type='token'`
- Combined usage counts towards user monthly limits

### Cost Breakdown
- **Token costs**: Calculated based on LLM model pricing (with 1.5x multiplier)
- **Tool costs**: Fixed per-tool costs defined in `tool_costs` table
- **Total costs**: Token costs + Tool costs = Total monthly usage

### Analytics Views
- **Enterprise admin**: Can view all users' tool usage via admin endpoints
- **Individual users**: Can view their own tool usage via `/tool-usage-analytics`
- **Reporting**: Tool usage analytics provide granular cost tracking

## Configuration Options

### Tool Cost Management
```sql
-- Update tool cost
UPDATE tool_costs SET cost_dollars = 0.07 WHERE tool_name = 'browser_screenshot';

-- Disable tool charging
UPDATE tool_costs SET is_active = false WHERE tool_name = 'expensive_tool';

-- Add new tool
INSERT INTO tool_costs (tool_name, cost_dollars, description) 
VALUES ('new_tool', 0.15, 'New tool description');
```

### User Limit Management  
```sql
-- Set user monthly limit
INSERT INTO enterprise_user_limits (account_id, monthly_limit) 
VALUES ('user-uuid', 500.00) 
ON CONFLICT (account_id) DO UPDATE SET monthly_limit = 500.00;

-- View user usage
SELECT account_id, monthly_limit, current_month_usage, 
       (monthly_limit - current_month_usage) as remaining
FROM enterprise_user_limits 
WHERE account_id = 'user-uuid';
```

## Migration from Previous System

### Backward Compatibility
- Existing enterprise usage logs remain unchanged
- LLM token billing continues to work exactly as before
- New tool tracking is additive, doesn't break existing functionality

### Gradual Rollout
1. **Phase 1**: Deploy with `ENTERPRISE_MODE=true` - tool tracking enabled
2. **Phase 2**: Monitor tool usage patterns and costs
3. **Phase 3**: Adjust tool costs based on actual usage data

## Troubleshooting

### Common Issues

1. **"Insufficient credits" errors**
   - Check enterprise credit balance: `SELECT * FROM enterprise_billing;`
   - Check user monthly limits: `SELECT * FROM enterprise_user_limits;`
   - Verify tool costs: `SELECT * FROM tool_costs WHERE is_active = true;`

2. **Tool usage not being tracked**
   - Verify `ENTERPRISE_MODE=true` in config
   - Check database function permissions
   - Ensure migration was applied successfully

3. **Analytics not showing data**
   - Confirm `usage_type='tool'` records exist in `enterprise_usage`
   - Check date range filters in analytics queries
   - Verify view permissions on `enterprise_tool_usage_analytics`

### Debug Queries
```sql
-- Check recent tool usage
SELECT * FROM enterprise_usage 
WHERE usage_type = 'tool' 
ORDER BY created_at DESC 
LIMIT 10;

-- Check user's monthly usage breakdown
SELECT 
    usage_type,
    COUNT(*) as usage_count,
    SUM(cost) as total_cost
FROM enterprise_usage 
WHERE account_id = 'user-uuid' 
  AND created_at >= date_trunc('month', now())
GROUP BY usage_type;

-- Check tool cost configuration
SELECT tool_name, cost_dollars, is_active 
FROM tool_costs 
ORDER BY cost_dollars DESC;
```

## Summary

This integration brings enterprise mode tool tracking in line with regular billing mode while maintaining the shared credit pool model. Users now get:

- **Transparency**: See exactly what tools they're using and what they cost
- **Control**: Pre-execution checks prevent overspending
- **Analytics**: Detailed usage reports for optimization
- **Consistency**: Same tool tracking experience regardless of billing mode

The system maintains backward compatibility while adding powerful new tracking and analytics capabilities for enterprise customers.
