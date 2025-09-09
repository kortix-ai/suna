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
                # Get default limit from global settings
                default_limit = await self.get_default_monthly_limit()
                remaining = default_limit
            
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
                    # Debug: Log usage recording for real-time tracking
                    logger.info(f"USAGE RECORDED: Account {account_id} used ${amount:.4f} for thread {thread_id}, message {message_id}, model {model_name}")
                    # Invalidate caches to ensure frontend sees updates immediately  
                    try:
                        from utils.cache import Cache
                        await Cache.invalidate(f"monthly_usage:{account_id}")
                        await Cache.invalidate(f"user_subscription:{account_id}")
                        await Cache.invalidate(f"allowed_models_for_user:{account_id}")
                        logger.debug(f"Invalidated billing caches for account {account_id} after enterprise usage")
                    except Exception as cache_error:
                        logger.warning(f"Failed to invalidate enterprise billing caches: {cache_error}")
                    
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
    
    async def get_global_setting(self, setting_key: str) -> Optional[Dict[str, Any]]:
        """Get a global enterprise setting."""
        if not config.ENTERPRISE_MODE:
            return None
            
        try:
            db = DBConnection()
            client = await db.client
            
            result = await client.table('enterprise_global_settings')\
                .select('*')\
                .eq('setting_key', setting_key)\
                .maybe_single()\
                .execute()
            
            if result and hasattr(result, 'data') and result.data:
                return result.data
            return None
                
        except Exception as e:
            logger.error(f"Error getting global setting {setting_key}: {e}")
            return None
    
    async def set_global_setting(
        self,
        setting_key: str,
        setting_value: Dict[str, Any],
        description: str = None,
        updated_by: str = None
    ) -> Dict[str, Any]:
        """Set or update a global enterprise setting."""
        if not config.ENTERPRISE_MODE:
            raise ValueError("Enterprise mode not enabled")
            
        try:
            db = DBConnection()
            client = await db.client
            
            # Check if setting exists
            existing = await self.get_global_setting(setting_key)
            
            if existing:
                # Update existing setting
                result = await client.table('enterprise_global_settings')\
                    .update({
                        'setting_value': setting_value,
                        'description': description,
                        'updated_by': updated_by
                    })\
                    .eq('setting_key', setting_key)\
                    .execute()
            else:
                # Create new setting
                result = await client.table('enterprise_global_settings')\
                    .insert({
                        'setting_key': setting_key,
                        'setting_value': setting_value,
                        'description': description,
                        'created_by': updated_by,
                        'updated_by': updated_by
                    })\
                    .execute()
            
            if result.data and len(result.data) > 0:
                return result.data[0]
            else:
                raise Exception("No data returned from setting update")
                
        except Exception as e:
            logger.error(f"Error setting global setting {setting_key}: {e}")
            raise
    
    async def update_users_with_default_limit(self, old_default: float, new_default: float) -> int:
        """Update ALL active users to the new global default limit."""
        if not config.ENTERPRISE_MODE:
            return 0
            
        try:
            db = DBConnection()
            client = await db.client
            
            # Get all active users before the update
            all_users_result = await client.table('enterprise_user_limits')\
                .select('account_id, monthly_limit')\
                .eq('is_active', True)\
                .execute()
            
            users_before = all_users_result.data if all_users_result.data else []
            logger.info(f"Found {len(users_before)} active users to update to new default: ${new_default}")
            
            # Update ALL active users to the new global default
            # This ensures consistency and avoids the complexity of tracking "default vs custom" limits
            result = await client.table('enterprise_user_limits')\
                .update({'monthly_limit': new_default})\
                .eq('is_active', True)\
                .execute()
            
            # Return count of updated users
            updated_count = len(result.data) if result.data else 0
            
            logger.info(f"Successfully updated {updated_count} users to new global default: ${new_default}")
            
            return updated_count
            
        except Exception as e:
            logger.error(f"Error updating users with default limit: {e}")
            return 0
    
    async def get_default_monthly_limit(self) -> float:
        """Get the default monthly limit from global settings."""
        try:
            setting = await self.get_global_setting('default_monthly_limit')
            if setting and 'setting_value' in setting:
                value = setting['setting_value'].get('value')
                if value and isinstance(value, (int, float)) and value > 0:
                    return float(value)
            
            # Fallback to hardcoded default
            return 100.00
                
        except Exception as e:
            logger.error(f"Error getting default monthly limit: {e}")
            return 100.00
    
    async def get_user_limit(self, account_id: str) -> Dict[str, Any]:
        """Get a user's monthly limit and current usage."""
        if not config.ENTERPRISE_MODE:
            return None
        
        try:
            db = DBConnection()
            client = await db.client
            
            # Get default limit from global settings
            default_limit = await self.get_default_monthly_limit()
            
            result = await client.table('enterprise_user_limits')\
                .select('*')\
                .eq('account_id', account_id)\
                .maybe_single()\
                .execute()
            
            if result and hasattr(result, 'data') and result.data:
                user_data = result.data
                # Add flag to indicate if this user has custom limit vs default
                user_data['using_default_limit'] = False
                return user_data
            else:
                # Return default if not set
                return {
                    'account_id': account_id,
                    'monthly_limit': default_limit,
                    'current_month_usage': 0,
                    'is_active': True,
                    'using_default_limit': True
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
            
            # Enrich user data with account names and user emails
            for user in users_data:
                try:
                    # Get account info with user email from auth.users
                    account_result = await client.schema("basejump")\
                        .table("accounts")\
                        .select('id, name, personal_account, primary_owner_user_id')\
                        .eq('id', user['account_id'])\
                        .maybe_single()\
                        .execute()
                    
                    if account_result and hasattr(account_result, 'data') and account_result.data:
                        account_data = account_result.data
                        
                        # If account name is empty and it's a personal account, get email from auth.users
                        display_name = account_data.get('name')
                        if (not display_name or display_name.strip() == '') and account_data.get('personal_account'):
                            try:
                                user_result = await client.schema("auth")\
                                    .table("users")\
                                    .select('email')\
                                    .eq('id', account_data['primary_owner_user_id'])\
                                    .maybe_single()\
                                    .execute()
                                
                                if user_result and hasattr(user_result, 'data') and user_result.data:
                                    user_email = user_result.data.get('email', '')
                                    if user_email:
                                        display_name = user_email.split('@')[0]  # Use email prefix as name
                            except Exception as e:
                                logger.warning(f"Could not fetch user email for {account_data['primary_owner_user_id']}: {e}")
                        
                        # Use display_name if we have it, otherwise fallback to account ID
                        final_name = display_name if display_name and display_name.strip() else f"Account {user['account_id'][:8]}..."
                        
                        user['account_info'] = {
                            'id': account_data['id'],
                            'name': final_name,
                            'personal_account': account_data.get('personal_account', True)
                        }
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
            total_monthly_limit = sum(u['monthly_limit'] for u in users_data)
            total_monthly_usage = sum(u['current_month_usage'] for u in users_data)
            
            return {
                'enterprise_balance': enterprise['credit_balance'] if enterprise else 0,
                'total_loaded': enterprise['total_loaded'] if enterprise else 0,
                'total_used': enterprise['total_used'] if enterprise else 0,
                'total_monthly_limit': total_monthly_limit,
                'total_monthly_usage': total_monthly_usage,
                'remaining_monthly_budget': total_monthly_limit - total_monthly_usage,
                'users': users_data,  # Return enriched user data with account names
                'total_users': count_result.count if count_result else 0,
                'page': page,
                'items_per_page': items_per_page
            }
            
        except Exception as e:
            logger.error(f"Error getting all user usage: {e}")
            return None
    

    async def get_user_hierarchical_usage(
        self,
        account_id: str,
        days: int = 30,
        page: int = 0,
        items_per_page: int = 100
    ) -> Dict[str, Any]:
        """
        Get hierarchical usage data for enterprise users.
        Returns data grouped by Date → Project/Thread → Individual Usage entries.
        """
        if not config.ENTERPRISE_MODE:
            return None
        
        try:
            db = DBConnection()
            client = await db.client
            
            # Get user's limit info
            user_limit = await self.get_user_limit(account_id)
            
            # Query enterprise usage directly for real-time updates (like Stripe system)
            since_date = datetime.now() - timedelta(days=days)
            
            # Get raw enterprise usage data with pagination (temporarily remove date filter for debugging)
            usage_query = client.from_('enterprise_usage').select(
                'id, account_id, thread_id, message_id, cost, model_name, tokens_used, created_at, tool_name, tool_cost, usage_type'
            )
            usage_query = usage_query.eq('account_id', account_id)
            # TEMPORARILY COMMENT OUT DATE FILTER FOR DEBUGGING
            # usage_query = usage_query.gte('created_at', since_date.isoformat())
            usage_query = usage_query.order('created_at', desc=True)
            usage_query = usage_query.limit(items_per_page)
            usage_query = usage_query.offset(page * items_per_page)
            usage_result = await usage_query.execute()
            
            # Debug: Log what we found
            logger.info(f"Querying enterprise usage for account {account_id} since {since_date.isoformat()}")
            logger.info(f"Found {len(usage_result.data) if usage_result.data else 0} usage records for account {account_id}")
            if usage_result.data:
                logger.info(f"Latest record: {usage_result.data[0]}")
            
            # Also check total count without date filter for debugging
            debug_count_query = client.from_('enterprise_usage').select('id', count='exact')
            debug_count_query = debug_count_query.eq('account_id', account_id)
            debug_count_result = await debug_count_query.execute()
            logger.info(f"Total usage records for account {account_id}: {debug_count_result.count if debug_count_result else 0}")
            
            if not usage_result or not usage_result.data:
                return {
                    'account_id': account_id,
                    'monthly_limit': user_limit['monthly_limit'] if user_limit else await self.get_default_monthly_limit(),
                    'current_month_usage': user_limit['current_month_usage'] if user_limit else 0,
                    'remaining_monthly': (user_limit['monthly_limit'] - user_limit['current_month_usage']) if user_limit else await self.get_default_monthly_limit(),
                    'hierarchical_usage': {},
                    'total_cost_period': 0,
                    'page': page,
                    'items_per_page': items_per_page,
                    'days': days
                }
            
            # Get thread and project info for mapping (like Stripe system)
            thread_ids = list(set([row['thread_id'] for row in usage_result.data if row['thread_id']]))
            thread_info = {}
            
            if thread_ids:
                # Get thread info
                threads_query = client.from_('threads').select('thread_id, project_id')
                threads_query = threads_query.in_('thread_id', thread_ids)
                threads_result = await threads_query.execute()
                
                # Get project info
                project_ids = list(set([thread['project_id'] for thread in threads_result.data if thread['project_id']]))
                project_info = {}
                if project_ids:
                    projects_query = client.from_('projects').select('project_id, name')
                    projects_query = projects_query.in_('project_id', project_ids)
                    projects_result = await projects_query.execute()
                    
                    for project in projects_result.data:
                        project_info[project['project_id']] = project['name']
                
                # Map threads to projects
                for thread in threads_result.data:
                    thread_info[thread['thread_id']] = {
                        'project_id': thread['project_id'],
                        'project_name': project_info.get(thread['project_id'], 'Untitled Project')
                    }
            
            # Get message content for token breakdown (like Stripe system)
            message_ids = list(set([row['message_id'] for row in usage_result.data if row['message_id']]))
            message_content = {}
            
            if message_ids:
                messages_query = client.from_('messages').select('message_id, content')
                messages_query = messages_query.in_('message_id', message_ids)
                messages_result = await messages_query.execute()
                
                for message in messages_result.data:
                    message_content[message['message_id']] = message.get('content', {})
            
            # Process data and group by date/thread (real-time, no caching)
            hierarchical_data = {}
            total_cost = 0
            thread_groups = {}
            
            # Process raw usage data (like Stripe system - real-time, no caching)
            for row in usage_result.data:
                usage_date = row['created_at'][:10]  # Extract date from timestamp
                thread_id = row['thread_id'] 
                thread_data = thread_info.get(thread_id, {'project_id': None, 'project_name': 'Untitled Project'})
                
                # Get thread grouping key
                thread_key = f"{usage_date}_{thread_id}"
                
                # Initialize thread group if not exists
                if thread_key not in thread_groups:
                    thread_groups[thread_key] = {
                        'usage_date': usage_date,
                        'thread_id': thread_id,
                        'project_id': thread_data['project_id'],
                        'project_title': thread_data['project_name'],
                        'thread_title': 'Untitled Chat',  # threads don't have titles
                        'thread_cost': 0,
                        'usage_details': []
                    }
                
                # Add this usage record
                cost = float(row['cost'] or 0)
                usage_type = row.get('usage_type', 'token')
                
                # Debug: Log each record processing
                logger.debug(f"Processing usage record: cost={cost}, usage_type={usage_type}, created_at={row['created_at']}")
                
                thread_groups[thread_key]['thread_cost'] += cost
                total_cost += cost
                
                # Handle different usage types
                if usage_type == 'tool':
                    # Tool usage - calculate tool_tokens from tool_cost
                    tool_cost = float(row.get('tool_cost', 0) or 0)
                    # Assume tools cost about $0.01 per "token" (adjust as needed)
                    tool_tokens = int(tool_cost * 100) if tool_cost > 0 else 0
                    
                    usage_detail = {
                        'id': row['id'],
                        'message_id': row['message_id'],
                        'created_at': row['created_at'],
                        'cost': cost,
                        'model_name': row['model_name'],
                        'prompt_tokens': 0,
                        'completion_tokens': 0,
                        'tool_tokens': tool_tokens,
                        'total_cost': cost,
                        'usage_type': usage_type,
                        'tool_name': row.get('tool_name'),
                        'tool_cost': tool_cost
                    }
                else:
                    # Token usage - get prompt/completion tokens from message content
                    content = message_content.get(row['message_id'], {})
                    usage_info = content.get('usage', {}) if content else {}
                    
                    prompt_tokens = usage_info.get('prompt_tokens', 0) or 0
                    completion_tokens = usage_info.get('completion_tokens', 0) or 0
                    
                    # Debug: Log token breakdown and cost calculation verification
                    if prompt_tokens > 0 or completion_tokens > 0:
                        # Verify cost calculation for known models
                        expected_cost = 0
                        if row['model_name'] == 'claude-sonnet-4-20250514':
                            # Sonnet 4 pricing: $4.50 per 1M input, $22.50 per 1M output
                            expected_cost = (prompt_tokens * 4.50 / 1000000) + (completion_tokens * 22.50 / 1000000)
                        
                        cost_diff = abs(cost - expected_cost) if expected_cost > 0 else 0
                        cost_match = cost_diff < 0.001  # Within 0.1 cent tolerance
                        
                        logger.debug(f"Token breakdown for {row['model_name']}: prompt={prompt_tokens}, completion={completion_tokens}")
                        logger.debug(f"Cost verification: actual=${cost:.6f}, expected=${expected_cost:.6f}, match={cost_match}")
                        
                        if not cost_match and expected_cost > 0:
                            logger.warning(f"Cost mismatch detected! Actual: ${cost:.6f}, Expected: ${expected_cost:.6f}, Diff: ${cost_diff:.6f}")
                    
                    usage_detail = {
                        'id': row['id'],
                        'message_id': row['message_id'],
                        'created_at': row['created_at'],
                        'cost': cost,
                        'model_name': row['model_name'],
                        'prompt_tokens': prompt_tokens,
                        'completion_tokens': completion_tokens,
                        'tool_tokens': 0,
                        'total_cost': cost,
                        'usage_type': usage_type,
                        'tool_name': row.get('tool_name'),
                        'tool_cost': float(row.get('tool_cost', 0) or 0)
                    }
                thread_groups[thread_key]['usage_details'].append(usage_detail)
            
            # Convert thread groups to hierarchical structure by date
            for thread_key, thread_data in thread_groups.items():
                usage_date = thread_data['usage_date']
                thread_id = thread_data['thread_id']
                
                # Group by date
                if usage_date not in hierarchical_data:
                    hierarchical_data[usage_date] = {
                        'date': usage_date,
                        'total_cost': 0,
                        'projects': {}
                    }
                
                # Add thread to date
                if thread_id not in hierarchical_data[usage_date]['projects']:
                    hierarchical_data[usage_date]['projects'][thread_id] = thread_data
                
                # Update daily totals
                hierarchical_data[usage_date]['total_cost'] += thread_data['thread_cost']
            
            return {
                'account_id': account_id,
                'monthly_limit': user_limit['monthly_limit'] if user_limit else await self.get_default_monthly_limit(),
                'current_month_usage': user_limit['current_month_usage'] if user_limit else 0,
                'remaining_monthly': (user_limit['monthly_limit'] - user_limit['current_month_usage']) if user_limit else await self.get_default_monthly_limit(),
                'hierarchical_usage': hierarchical_data,
                'total_cost_period': total_cost,
                'page': page,
                'items_per_page': items_per_page,
                'days': days
            }
            
        except Exception as e:
            logger.error(f"Error getting hierarchical usage data: {e}")
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
    
    async def _get_tool_usage_by_date(
        self,
        account_id: str,
        days: int = 30
    ) -> Dict[str, Dict[str, Any]]:
        """
        Get tool usage aggregated by day in the same format as Stripe billing.
        Returns data in format: {date: {total_calls, total_cost, tools: {tool_name: {calls, cost}}}}
        """
        if not config.ENTERPRISE_MODE:
            return {}
        
        try:
            db = DBConnection()
            client = await db.client
            
            # Calculate date range
            since_date = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
            
            # Get tool usage data from enterprise_tool_usage_analytics view
            tool_result = await client.from_('enterprise_tool_usage_analytics').select('*')\
                .eq('account_id', account_id)\
                .gte('created_at', since_date)\
                .order('created_at', desc=True)\
                .execute()
            
            tool_usage_daily = {}
            
            if tool_result and hasattr(tool_result, 'data') and tool_result.data:
                for tool_usage in tool_result.data:
                    try:
                        # Extract date from created_at or usage_date
                        usage_date = tool_usage.get('usage_date')
                        if not usage_date:
                            created_at = tool_usage.get('created_at')
                            if created_at:
                                # Extract date part from datetime string
                                usage_date = created_at.split('T')[0]
                        
                        if not usage_date:
                            continue
                        
                        # Convert to date string for consistency
                        if isinstance(usage_date, str) and 'T' in usage_date:
                            usage_date = usage_date.split('T')[0]
                        else:
                            usage_date = str(usage_date).split('T')[0]
                        
                        # Initialize date entry if not exists
                        if usage_date not in tool_usage_daily:
                            tool_usage_daily[usage_date] = {
                                'total_calls': 0,
                                'total_cost': 0.0,
                                'tools': {}
                            }
                        
                        tool_name = tool_usage.get('tool_name', 'unknown')
                        cost = float(tool_usage.get('tool_cost', 0))
                        
                        # Update daily totals
                        tool_usage_daily[usage_date]['total_calls'] += 1
                        tool_usage_daily[usage_date]['total_cost'] += cost
                        
                        # Update per-tool totals
                        if tool_name not in tool_usage_daily[usage_date]['tools']:
                            tool_usage_daily[usage_date]['tools'][tool_name] = {
                                'calls': 0,
                                'cost': 0.0
                            }
                        
                        tool_usage_daily[usage_date]['tools'][tool_name]['calls'] += 1
                        tool_usage_daily[usage_date]['tools'][tool_name]['cost'] += cost
                        
                    except Exception as parse_error:
                        logger.warning(f"Error parsing tool usage entry: {parse_error}")
                        continue
            
            return tool_usage_daily
            
        except Exception as e:
            logger.error(f"Error getting tool usage by date for account {account_id}: {e}")
            return {}
    
    async def can_user_afford_tool(
        self,
        account_id: str,
        tool_name: str
    ) -> Dict[str, Any]:
        """
        Check if a user can afford a specific tool in enterprise mode.
        """
        if not config.ENTERPRISE_MODE:
            return {'can_use': False, 'required_cost': 0.0, 'current_balance': 0.0, 'user_remaining': 0.0}
        
        try:
            db = DBConnection()
            client = await db.client
            
            result = await client.rpc('enterprise_can_use_tool', {
                'p_account_id': account_id,
                'p_tool_name': tool_name
            }).execute()
            
            if result and hasattr(result, 'data') and result.data and len(result.data) > 0:
                data = result.data[0]
                return {
                    'can_use': data['can_use'],
                    'required_cost': float(data['required_cost']),
                    'current_balance': float(data['current_balance']),
                    'user_remaining': float(data['user_remaining'])
                }
            
            return {'can_use': False, 'required_cost': 0.0, 'current_balance': 0.0, 'user_remaining': 0.0}
            
        except Exception as e:
            logger.error(f"Error checking tool affordability for {tool_name}: {e}")
            return {'can_use': False, 'required_cost': 0.0, 'current_balance': 0.0, 'user_remaining': 0.0}
    
    async def charge_tool_usage(
        self,
        account_id: str,
        tool_name: str,
        thread_id: str = None,
        message_id: str = None
    ) -> Dict[str, Any]:
        """
        Charge for tool usage in enterprise mode.
        """
        if not config.ENTERPRISE_MODE:
            return {'success': False, 'cost_charged': 0.0, 'new_balance': 0.0, 'user_remaining': 0.0}
        
        try:
            db = DBConnection()
            client = await db.client
            
            result = await client.rpc('enterprise_use_tool_credits', {
                'p_account_id': account_id,
                'p_tool_name': tool_name,
                'p_thread_id': thread_id,
                'p_message_id': message_id
            }).execute()
            
            if result and hasattr(result, 'data') and result.data and len(result.data) > 0:
                data = result.data[0]
                
                if data['success']:
                    logger.debug(
                        f"Charged ${data['cost_charged']:.4f} for tool {tool_name} usage by account {account_id}",
                        account_id=account_id,
                        tool_name=tool_name,
                        cost_charged=data['cost_charged'],
                        new_balance=data['new_balance']
                    )
                    
                    # Invalidate caches after successful tool billing
                    try:
                        from utils.cache import Cache
                        await Cache.invalidate(f"monthly_usage:{account_id}")
                        await Cache.invalidate(f"user_subscription:{account_id}")
                        await Cache.invalidate(f"allowed_models_for_user:{account_id}")
                        logger.debug(f"Invalidated billing caches for account {account_id} after tool billing")
                    except Exception as cache_error:
                        logger.warning(f"Failed to invalidate caches after tool billing: {cache_error}")
                
                return {
                    'success': data['success'],
                    'cost_charged': float(data['cost_charged']),
                    'new_balance': float(data['new_balance']),
                    'user_remaining': float(data['user_remaining'])
                }
            
            return {'success': False, 'cost_charged': 0.0, 'new_balance': 0.0, 'user_remaining': 0.0}
            
        except Exception as e:
            logger.error(f"Error charging tool usage for {tool_name}: {e}")
            return {'success': False, 'cost_charged': 0.0, 'new_balance': 0.0, 'user_remaining': 0.0}
    
    async def get_tool_usage_analytics(
        self,
        account_id: str = None,
        days: int = 30,
        page: int = 0,
        items_per_page: int = 100
    ) -> Dict[str, Any]:
        """
        Get tool usage analytics for enterprise accounts.
        """
        if not config.ENTERPRISE_MODE:
            return None
        
        try:
            db = DBConnection()
            client = await db.client
            
            # Calculate date range
            since_date = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
            
            query = client.from_('enterprise_tool_usage_analytics').select('*')
            
            if account_id:
                query = query.eq('account_id', account_id)
            
            # Get paginated results
            result = await query.gte('created_at', since_date)\
                .order('created_at', desc=True)\
                .range(page * items_per_page, (page + 1) * items_per_page - 1)\
                .execute()
            
            # Get total count
            count_query = client.from_('enterprise_tool_usage_analytics').select('account_id', count='exact')
            
            if account_id:
                count_query = count_query.eq('account_id', account_id)
            
            count_result = await count_query.gte('created_at', since_date).execute()
            
            usage_data = result.data if (result and hasattr(result, 'data') and result.data) else []
            total_count = count_result.count if (count_result and hasattr(count_result, 'count')) else 0
            
            # Calculate total cost
            total_cost = sum(float(item.get('tool_cost', 0)) for item in usage_data)
            
            return {
                'tool_usage': usage_data,
                'total_logs': total_count,
                'page': page,
                'items_per_page': items_per_page,
                'total_cost_period': total_cost,
                'period_days': days
            }
            
        except Exception as e:
            logger.error(f"Error getting tool usage analytics: {e}")
            return None

# Create singleton instance
enterprise_billing = SimplifiedEnterpriseBillingService()