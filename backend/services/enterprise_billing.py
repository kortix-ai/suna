"""
Simplified Enterprise Billing Service

When ENTERPRISE_MODE is enabled:
- ALL users share ONE credit pool
- Per-user monthly limits are enforced
- Usage is tracked per user for visibility
- Credits are manually loaded by admins
"""

from typing import Optional, Dict, Any, Tuple, List
from datetime import datetime, timezone, timedelta
from decimal import Decimal
import structlog

from utils.config import config
from services.supabase import DBConnection

logger = structlog.get_logger(__name__)

# Fixed enterprise billing account ID
ENTERPRISE_BILLING_ID = '00000000-0000-0000-0000-000000000000'

class SimplifiedEnterpriseBillingService:
    """
    Simplified enterprise billing service.
    When ENTERPRISE_MODE is enabled, ALL users are enterprise users.
    """
    
    def __init__(self):
        self.db = DBConnection()
    
    @staticmethod
    async def check_enterprise_mode() -> bool:
        """Check if enterprise mode is enabled."""
        return config.ENTERPRISE_MODE
    
    async def get_enterprise_balance(self) -> Dict[str, Any]:
        """Get the single enterprise billing account balance."""
        if not config.ENTERPRISE_MODE:
            return None
            
        db = DBConnection()
        client = await db.client
        
        result = await client.table('enterprise_billing')\
            .select('*')\
            .eq('id', ENTERPRISE_BILLING_ID)\
            .single()\
            .execute()
        
        return result.data if result.data else None
    
    async def check_billing_status(self, account_id: str) -> Tuple[bool, str, Optional[Dict]]:
        """
        Check if a user can run agents based on enterprise credits and limits.
        When ENTERPRISE_MODE is enabled, this replaces the normal billing check.
        """
        if not config.ENTERPRISE_MODE:
            # This shouldn't be called if enterprise mode is disabled
            return False, "Enterprise mode not enabled", None
        
        try:
            db = DBConnection()
            client = await db.client
            
            # Get enterprise balance
            enterprise = await self.get_enterprise_balance()
            if not enterprise:
                return False, "Enterprise billing not configured", None
            
            # Get user's limit and usage
            user_limit_result = await client.table('enterprise_user_limits')\
                .select('*')\
                .eq('account_id', account_id)\
                .eq('is_active', True)\
                .maybe_single()\
                .execute()
            
            if user_limit_result and hasattr(user_limit_result, 'data') and user_limit_result.data:
                user_limit = user_limit_result.data
                remaining = user_limit['monthly_limit'] - user_limit['current_month_usage']
            else:
                # Default limit if not set
                remaining = 1000.00
            
            # Check if enterprise has credits
            if enterprise['credit_balance'] < 0.01:  # Minimum to start
                return False, "Insufficient enterprise credits. Contact admin to load credits.", {
                    'enterprise_balance': enterprise['credit_balance'],
                    'user_remaining': remaining
                }
            
            # Check if user has remaining monthly allowance
            if remaining <= 0:
                return False, f"Monthly limit reached. Contact admin to increase limit.", {
                    'enterprise_balance': enterprise['credit_balance'],
                    'user_remaining': 0
                }
            
            # All good - user can proceed
            return True, "OK", {
                'enterprise_balance': enterprise['credit_balance'],
                'user_remaining': remaining,
                'plan_name': 'Enterprise',
                'price_id': 'enterprise'
            }
            
        except Exception as e:
            logger.error(f"Error checking enterprise billing status: {e}")
            return False, f"Error checking billing status: {str(e)}", None
    
    async def use_enterprise_credits(
        self,
        account_id: str,
        amount: float,
        thread_id: str = None,
        message_id: str = None,
        model_name: str = None
    ) -> Tuple[bool, str]:
        """
        Use credits from the enterprise pool for a user.
        Enforces per-user monthly limits.
        """
        if not config.ENTERPRISE_MODE:
            return False, "Enterprise mode not enabled"
        
        try:
            db = DBConnection()
            client = await db.client
            
            # Call the database function to handle the transaction atomically
            result = await client.rpc('use_enterprise_credits_simple', {
                'p_account_id': account_id,
                'p_amount': amount,
                'p_thread_id': thread_id,
                'p_message_id': message_id,
                'p_model_name': model_name
            }).execute()
            
            if result and hasattr(result, 'data') and result.data and len(result.data) > 0:
                response = result.data[0]
                if response['success']:
                    logger.debug(
                        f"Used ${amount:.4f} enterprise credits for account {account_id}",
                        account_id=account_id,
                        amount=amount,
                        new_balance=response['new_balance']
                    )
                    return True, f"Used ${amount:.4f} from enterprise credits (Balance: ${response['new_balance']:.2f})"
                else:
                    return False, response['message']
            
            return False, "Failed to use enterprise credits"
            
        except Exception as e:
            logger.error(f"Error using enterprise credits: {e}")
            return False, f"Error using credits: {str(e)}"
    
    async def load_credits(
        self,
        amount: float,
        description: str = None,
        performed_by: str = None
    ) -> Dict[str, Any]:
        """Load credits into the enterprise account."""
        if not config.ENTERPRISE_MODE:
            raise ValueError("Enterprise mode not enabled")
        
        try:
            db = DBConnection()
            client = await db.client
            
            # Call the database function
            result = await client.rpc('load_enterprise_credits', {
                'p_amount': amount,
                'p_description': description,
                'p_performed_by': performed_by
            }).execute()
            
            if result and hasattr(result, 'data') and result.data and len(result.data) > 0:
                response = result.data[0]
                logger.info(
                    f"Loaded ${amount:.2f} enterprise credits",
                    amount=amount,
                    new_balance=response['new_balance'],
                    performed_by=performed_by
                )
                return {
                    'success': True,
                    'new_balance': response['new_balance'],
                    'amount_loaded': amount
                }
            
            return {'success': False, 'error': 'Failed to load credits'}
            
        except Exception as e:
            logger.error(f"Error loading enterprise credits: {e}")
            raise
    
    async def get_user_limit(self, account_id: str) -> Dict[str, Any]:
        """Get a user's monthly limit and current usage."""
        if not config.ENTERPRISE_MODE:
            return None
        
        try:
            db = DBConnection()
            client = await db.client
            
            result = await client.table('enterprise_user_limits')\
                .select('*')\
                .eq('account_id', account_id)\
                .maybe_single()\
                .execute()
            
            if result and hasattr(result, 'data') and result.data:
                return result.data
            else:
                # Return default if not set
                return {
                    'account_id': account_id,
                    'monthly_limit': 1000.00,
                    'current_month_usage': 0,
                    'is_active': True
                }
                
        except Exception as e:
            logger.error(f"Error getting user limit: {e}")
            return None
    
    async def set_user_limit(
        self,
        account_id: str,
        monthly_limit: float
    ) -> Dict[str, Any]:
        """Set a user's monthly spending limit."""
        if not config.ENTERPRISE_MODE:
            raise ValueError("Enterprise mode not enabled")
        
        try:
            db = DBConnection()
            client = await db.client
            
            # Upsert the limit
            result = await client.table('enterprise_user_limits')\
                .upsert({
                    'account_id': account_id,
                    'monthly_limit': monthly_limit,
                    'is_active': True,
                    'updated_at': datetime.now(timezone.utc).isoformat()
                }, on_conflict='account_id')\
                .execute()
            
            return result.data[0] if (result and hasattr(result, 'data') and result.data) else None
            
        except Exception as e:
            logger.error(f"Error setting user limit: {e}")
            raise
    
    async def get_all_user_usage(
        self,
        days: int = 30,
        page: int = 0,
        items_per_page: int = 100
    ) -> Dict[str, Any]:
        """
        Get usage statistics for all users.
        Returns aggregated data for the admin dashboard.
        """
        if not config.ENTERPRISE_MODE:
            return None
        
        try:
            db = DBConnection()
            client = await db.client
            
            # Get enterprise balance
            enterprise = await self.get_enterprise_balance()
            
            # Get user limits first
            limits_result = await client.table('enterprise_user_limits')\
                .select('*')\
                .eq('is_active', True)\
                .order('current_month_usage', desc=True)\
                .range(page * items_per_page, (page + 1) * items_per_page - 1)\
                .execute()
                
            # Get account info for each user (separate query to avoid cross-schema join issues)
            users_data = limits_result.data if (limits_result and hasattr(limits_result, 'data') and limits_result.data) else []
            
            # Enrich user data with account names
            for user in users_data:
                try:
                    account_result = await client.from_('basejump.accounts')\
                        .select('id, name, personal_account')\
                        .eq('id', user['account_id'])\
                        .maybe_single()\
                        .execute()
                    
                    if account_result and hasattr(account_result, 'data') and account_result.data:
                        user['account_info'] = account_result.data
                    else:
                        # Fallback if account not found
                        user['account_info'] = {
                            'id': user['account_id'],
                            'name': f"Account {user['account_id'][:8]}...",
                            'personal_account': True
                        }
                except Exception as e:
                    logger.warning(f"Could not fetch account info for {user['account_id']}: {e}")
                    user['account_info'] = {
                        'id': user['account_id'],
                        'name': f"Account {user['account_id'][:8]}...",
                        'personal_account': True
                    }
            
            # Get total count
            count_result = await client.table('enterprise_user_limits')\
                .select('account_id', count='exact')\
                .eq('is_active', True)\
                .execute()
            
            # Calculate aggregates
            total_monthly_limit = sum(u['monthly_limit'] for u in limits_result.data) if limits_result.data else 0
            total_monthly_usage = sum(u['current_month_usage'] for u in limits_result.data) if limits_result.data else 0
            
            return {
                'enterprise_balance': enterprise['credit_balance'] if enterprise else 0,
                'total_loaded': enterprise['total_loaded'] if enterprise else 0,
                'total_used': enterprise['total_used'] if enterprise else 0,
                'total_monthly_limit': total_monthly_limit,
                'total_monthly_usage': total_monthly_usage,
                'remaining_monthly_budget': total_monthly_limit - total_monthly_usage,
                'users': limits_result.data if limits_result.data else [],
                'total_users': count_result.count if count_result else 0,
                'page': page,
                'items_per_page': items_per_page
            }
            
        except Exception as e:
            logger.error(f"Error getting all user usage: {e}")
            return None
    
    async def get_user_usage_details(
        self,
        account_id: str,
        days: int = 30,
        page: int = 0,
        items_per_page: int = 100
    ) -> Dict[str, Any]:
        """
        Get detailed usage for a specific user.
        This is what the admin sees when clicking on a user.
        """
        if not config.ENTERPRISE_MODE:
            return None
        
        try:
            db = DBConnection()
            client = await db.client
            
            # Get user's limit info
            user_limit = await self.get_user_limit(account_id)
            
            # Get recent usage logs
            since_date = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
            
            usage_result = await client.table('enterprise_usage')\
                .select('*')\
                .eq('account_id', account_id)\
                .gte('created_at', since_date)\
                .order('created_at', desc=True)\
                .range(page * items_per_page, (page + 1) * items_per_page - 1)\
                .execute()
            
            # Get total count
            count_result = await client.table('enterprise_usage')\
                .select('id', count='exact')\
                .eq('account_id', account_id)\
                .gte('created_at', since_date)\
                .execute()
            
            # Calculate total cost for the period
            usage_data = usage_result.data if (usage_result and hasattr(usage_result, 'data') and usage_result.data) else []
            total_cost = sum(u['cost'] for u in usage_data)
            
            return {
                'account_id': account_id,
                'monthly_limit': user_limit['monthly_limit'] if user_limit else 1000.00,
                'current_month_usage': user_limit['current_month_usage'] if user_limit else 0,
                'remaining_monthly': (user_limit['monthly_limit'] - user_limit['current_month_usage']) if user_limit else 1000.00,
                'usage_logs': usage_data,
                'total_cost_period': total_cost,
                'total_logs': count_result.count if count_result else 0,
                'page': page,
                'items_per_page': items_per_page,
                'days': days
            }
            
        except Exception as e:
            logger.error(f"Error getting user usage details: {e}")
            return None
    
    async def reset_monthly_usage(self) -> bool:
        """
        Reset all users' monthly usage counters.
        This should be called by a scheduled job at the start of each month.
        """
        if not config.ENTERPRISE_MODE:
            return False
        
        try:
            db = DBConnection()
            client = await db.client
            
            await client.rpc('reset_enterprise_monthly_usage').execute()
            
            logger.info("Reset monthly usage for all enterprise users")
            return True
            
        except Exception as e:
            logger.error(f"Error resetting monthly usage: {e}")
            return False

# Create singleton instance
enterprise_billing = SimplifiedEnterpriseBillingService()