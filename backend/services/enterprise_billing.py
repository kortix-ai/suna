"""
Enterprise billing service for managing enterprise credit-based billing.

This service provides a complete enterprise billing system that operates independently
of the standard Stripe billing system. It supports:
- Credit-based billing with centralized enterprise accounts
- Per-user monthly spend limits within enterprise accounts
- Detailed usage tracking and reporting
- Manual credit loading and management

This is designed as a separate implementation that only activates when
ENTERPRISE_MODE is enabled in configuration.
"""

from typing import Optional, Tuple, Dict, List, Any
from decimal import Decimal
import asyncio
from datetime import datetime, timezone

from services.supabase import get_supabase_client
from utils.logger import logger, structlog
from utils.config import config
from utils.cache import Cache


class EnterpriseBillingService:
    """
    Comprehensive enterprise billing service.
    
    Handles all enterprise billing operations including:
    - Credit management and usage tracking
    - Monthly spend limits per user
    - Billing status checks
    - Usage analytics and reporting
    """
    
    @staticmethod
    async def is_enterprise_account(account_id: str) -> bool:
        """
        Check if an account is part of enterprise billing system.
        
        Args:
            account_id: The basejump account ID to check
            
        Returns:
            bool: True if account is enterprise, False otherwise
        """
        if not config.ENTERPRISE_MODE:
            logger.debug(f"Enterprise mode disabled, account {account_id} not enterprise")
            return False
            
        # Check cache first
        cache_key = f"is_enterprise_account:{account_id}"
        cached_result = await Cache.get(cache_key)
        if cached_result is not None:
            return cached_result
        
        try:
            client = await get_supabase_client()
            result = await client.rpc('get_enterprise_billing_status', {
                'p_account_id': account_id
            }).execute()
            
            is_enterprise = bool(result.data and result.data[0]['is_enterprise'])
            
            # Cache result for 5 minutes
            await Cache.set(cache_key, is_enterprise, ttl=300)
            
            logger.debug(f"Account {account_id} enterprise status: {is_enterprise}")
            return is_enterprise
            
        except Exception as e:
            logger.error(f"Error checking enterprise status for account {account_id}: {e}")
            return False
    
    @staticmethod
    async def check_enterprise_billing_status(account_id: str) -> Tuple[bool, str, Optional[Dict]]:
        """
        Check if an enterprise account can run agents based on credits and limits.
        
        Args:
            account_id: The basejump account ID to check
            
        Returns:
            Tuple[bool, str, Optional[Dict]]: (can_run, message, billing_info)
        """
        try:
            client = await get_supabase_client()
            
            # Get comprehensive billing status
            result = await client.rpc('get_enterprise_billing_status', {
                'p_account_id': account_id
            }).execute()
            
            if not result.data or not result.data[0]['is_enterprise']:
                return False, "Not an enterprise account", None
            
            billing_data = result.data[0]
            
            # Check if enterprise account is active
            if not billing_data['is_active']:
                return False, "Enterprise account is suspended", {
                    'enterprise_id': billing_data['enterprise_id'],
                    'enterprise_name': billing_data['enterprise_name'],
                    'is_active': False
                }
            
            # Check monthly limit
            monthly_limit = float(billing_data['monthly_limit'] or 0)
            current_usage = float(billing_data['current_usage'] or 0)
            remaining_monthly = float(billing_data['remaining_monthly'] or 0)
            
            if remaining_monthly <= 0:
                return False, f"Monthly spend limit of ${monthly_limit:.2f} reached", {
                    'enterprise_id': billing_data['enterprise_id'],
                    'enterprise_name': billing_data['enterprise_name'],
                    'monthly_limit': monthly_limit,
                    'current_usage': current_usage,
                    'remaining_monthly': 0
                }
            
            # Check enterprise balance
            credit_balance = float(billing_data['credit_balance'] or 0)
            if credit_balance <= 0:
                return False, "No enterprise credits available", {
                    'enterprise_id': billing_data['enterprise_id'],
                    'enterprise_name': billing_data['enterprise_name'],
                    'balance': credit_balance,
                    'monthly_limit': monthly_limit,
                    'current_usage': current_usage
                }
            
            # All checks passed
            return True, "OK", {
                'enterprise_id': billing_data['enterprise_id'],
                'enterprise_name': billing_data['enterprise_name'],
                'balance': credit_balance,
                'monthly_limit': monthly_limit,
                'current_usage': current_usage,
                'remaining_monthly': remaining_monthly,
                'is_active': True
            }
            
        except Exception as e:
            logger.error(f"Error checking enterprise billing status for account {account_id}: {e}")
            return False, "Error checking billing status", None
    
    @staticmethod
    async def use_enterprise_credits(
        account_id: str, 
        amount: float,
        thread_id: str = None,
        message_id: str = None,
        model_name: str = None,
        tokens_used: int = None
    ) -> Tuple[bool, str]:
        """
        Deduct credits from enterprise billing account.
        
        Args:
            account_id: The basejump account ID
            amount: Amount in dollars to deduct
            thread_id: Optional thread ID for tracking
            message_id: Optional message ID for tracking
            model_name: Optional model name for tracking
            tokens_used: Optional token count for tracking
            
        Returns:
            Tuple[bool, str]: (success, message)
        """
        try:
            client = await get_supabase_client()
            
            # Use the database function for atomic credit deduction
            result = await client.rpc('use_enterprise_credits', {
                'p_account_id': account_id,
                'p_amount': amount,
                'p_thread_id': thread_id,
                'p_message_id': message_id,
                'p_model_name': model_name,
                'p_tokens_used': tokens_used
            }).execute()
            
            if result.data and result.data[0]['success']:
                new_balance = result.data[0]['new_balance']
                logger.info(
                    f"Used ${amount:.4f} enterprise credits for account {account_id}",
                    account_id=account_id,
                    amount=amount,
                    new_balance=new_balance,
                    thread_id=thread_id,
                    message_id=message_id
                )
                
                # Clear relevant caches
                await Cache.delete(f"is_enterprise_account:{account_id}")
                
                return True, f"Used ${amount:.4f} enterprise credits (Balance: ${new_balance:.2f})"
            else:
                error_msg = result.data[0]['message'] if result.data else "Unknown error"
                logger.warning(
                    f"Failed to use enterprise credits for account {account_id}: {error_msg}",
                    account_id=account_id,
                    amount=amount,
                    error=error_msg
                )
                return False, error_msg
                
        except Exception as e:
            logger.error(
                f"Exception using enterprise credits for account {account_id}: {e}",
                account_id=account_id,
                amount=amount,
                error=str(e),
                exc_info=True
            )
            return False, f"Error using enterprise credits: {str(e)}"
    
    @staticmethod
    async def load_enterprise_credits(
        enterprise_id: str,
        amount: float,
        description: str = None,
        performed_by: str = None
    ) -> Tuple[bool, str]:
        """
        Load credits into an enterprise billing account.
        
        Args:
            enterprise_id: The enterprise billing account ID
            amount: Amount in dollars to load
            description: Optional description for the transaction
            performed_by: User ID who performed the loading
            
        Returns:
            Tuple[bool, str]: (success, message)
        """
        try:
            client = await get_supabase_client()
            
            # Use database function for atomic credit loading
            result = await client.rpc('load_enterprise_credits', {
                'p_enterprise_id': enterprise_id,
                'p_amount': amount,
                'p_description': description,
                'p_performed_by': performed_by
            }).execute()
            
            if result.data and result.data[0]['success']:
                new_balance = result.data[0]['new_balance']
                logger.info(
                    f"Loaded ${amount:.2f} credits into enterprise {enterprise_id}",
                    enterprise_id=enterprise_id,
                    amount=amount,
                    new_balance=new_balance,
                    performed_by=performed_by
                )
                return True, f"Loaded ${amount:.2f} credits (New balance: ${new_balance:.2f})"
            else:
                error_msg = result.data[0]['message'] if result.data else "Unknown error"
                logger.error(
                    f"Failed to load credits into enterprise {enterprise_id}: {error_msg}",
                    enterprise_id=enterprise_id,
                    amount=amount,
                    error=error_msg
                )
                return False, error_msg
                
        except Exception as e:
            logger.error(
                f"Exception loading credits into enterprise {enterprise_id}: {e}",
                enterprise_id=enterprise_id,
                amount=amount,
                error=str(e),
                exc_info=True
            )
            return False, f"Error loading credits: {str(e)}"
    
    @staticmethod
    async def get_enterprise_usage_stats(
        enterprise_id: str, 
        page: int = 0, 
        items_per_page: int = 100,
        start_date: datetime = None,
        end_date: datetime = None
    ) -> Dict[str, Any]:
        """
        Get comprehensive usage statistics for an enterprise billing account.
        
        Args:
            enterprise_id: The enterprise billing account ID
            page: Page number for pagination
            items_per_page: Items per page
            start_date: Optional start date filter
            end_date: Optional end date filter
            
        Returns:
            Dict containing usage statistics and member details
        """
        try:
            client = await get_supabase_client()
            
            # Get enterprise account info
            enterprise_info = await client.table('enterprise_billing_accounts')\
                .select('*')\
                .eq('id', enterprise_id)\
                .limit(1)\
                .execute()
            
            if not enterprise_info.data:
                return {'error': 'Enterprise account not found'}
            
            # Get all member accounts with their details
            members_query = client.table('enterprise_account_members')\
                .select('*, basejump.accounts(id, name)')\
                .eq('enterprise_billing_id', enterprise_id)\
                .eq('is_active', True)
            
            members = await members_query.execute()
            
            # Build usage logs query with pagination and filters
            usage_query = client.table('enterprise_usage_logs')\
                .select('*, basejump.accounts(id, name)')\
                .eq('enterprise_billing_id', enterprise_id)\
                .order('created_at', desc=True)
            
            # Apply date filters if provided
            if start_date:
                usage_query = usage_query.gte('created_at', start_date.isoformat())
            if end_date:
                usage_query = usage_query.lte('created_at', end_date.isoformat())
            
            # Apply pagination
            offset = page * items_per_page
            usage_query = usage_query.range(offset, offset + items_per_page - 1)
            
            usage_logs = await usage_query.execute()
            
            # Calculate summary statistics
            total_monthly_usage = sum(
                float(m['current_month_usage'] or 0) for m in members.data
            )
            total_monthly_limit = sum(
                float(m['monthly_spend_limit'] or 0) for m in members.data
            )
            
            # Get recent transaction history
            transactions = await client.table('enterprise_credit_transactions')\
                .select('*')\
                .eq('enterprise_billing_id', enterprise_id)\
                .order('created_at', desc=True)\
                .limit(10)\
                .execute()
            
            return {
                'enterprise_info': enterprise_info.data[0],
                'members': members.data,
                'member_count': len(members.data),
                'usage_logs': usage_logs.data,
                'total_monthly_usage': total_monthly_usage,
                'total_monthly_limit': total_monthly_limit,
                'remaining_monthly_budget': total_monthly_limit - total_monthly_usage,
                'recent_transactions': transactions.data,
                'page': page,
                'items_per_page': items_per_page,
                'has_more': len(usage_logs.data) == items_per_page
            }
            
        except Exception as e:
            logger.error(
                f"Error getting enterprise usage stats for {enterprise_id}: {e}",
                enterprise_id=enterprise_id,
                error=str(e),
                exc_info=True
            )
            return {'error': f'Failed to get usage stats: {str(e)}'}
    
    @staticmethod
    async def get_user_enterprise_info(account_id: str) -> Optional[Dict[str, Any]]:
        """
        Get enterprise information for a specific user account.
        
        Args:
            account_id: The basejump account ID
            
        Returns:
            Dict containing enterprise membership info or None if not enterprise
        """
        try:
            client = await get_supabase_client()
            
            result = await client.rpc('get_enterprise_billing_status', {
                'p_account_id': account_id
            }).execute()
            
            if result.data and result.data[0]['is_enterprise']:
                return result.data[0]
            
            return None
            
        except Exception as e:
            logger.error(f"Error getting user enterprise info for account {account_id}: {e}")
            return None
    
    @staticmethod
    async def update_user_monthly_limit(
        account_id: str,
        new_limit: float,
        updated_by: str = None
    ) -> Tuple[bool, str]:
        """
        Update the monthly spend limit for a user in enterprise billing.
        
        Args:
            account_id: The basejump account ID
            new_limit: New monthly spend limit in dollars
            updated_by: User ID who made the update
            
        Returns:
            Tuple[bool, str]: (success, message)
        """
        try:
            client = await get_supabase_client()
            
            # Validate limit
            if new_limit < 0:
                return False, "Monthly limit cannot be negative"
            
            # Update the limit
            result = await client.table('enterprise_account_members')\
                .update({
                    'monthly_spend_limit': new_limit,
                    'updated_at': datetime.now(timezone.utc).isoformat()
                })\
                .eq('account_id', account_id)\
                .eq('is_active', True)\
                .execute()
            
            if result.data:
                logger.info(
                    f"Updated monthly limit for account {account_id} to ${new_limit:.2f}",
                    account_id=account_id,
                    new_limit=new_limit,
                    updated_by=updated_by
                )
                
                # Clear cache
                await Cache.delete(f"is_enterprise_account:{account_id}")
                
                return True, f"Monthly limit updated to ${new_limit:.2f}"
            else:
                return False, "Account not found or not active in enterprise billing"
                
        except Exception as e:
            logger.error(
                f"Error updating monthly limit for account {account_id}: {e}",
                account_id=account_id,
                new_limit=new_limit,
                error=str(e),
                exc_info=True
            )
            return False, f"Error updating monthly limit: {str(e)}"


# Export singleton instance
enterprise_billing = EnterpriseBillingService()
