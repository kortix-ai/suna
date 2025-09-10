"""
Billing wrapper service that routes requests between Stripe and Enterprise billing.

This service acts as a unified interface that automatically determines whether to use
the standard Stripe billing system or the enterprise credit-based billing system
based on:
1. ENTERPRISE_MODE configuration flag
2. Account's enterprise membership status

This allows the rest of the codebase to remain unchanged while supporting both
billing systems seamlessly.
"""

from typing import Tuple, Optional, Dict, Any
import asyncio

from utils.logger import logger, structlog
from utils.config import config

# Import existing Stripe billing functions
from services.billing import (
    check_billing_status as stripe_check_billing_status,
    handle_usage_with_credits as stripe_handle_usage_with_credits,
    can_use_model as stripe_can_use_model,
    can_user_afford_tool as stripe_can_user_afford_tool,
    charge_tool_usage as stripe_charge_tool_usage
)

# Import enterprise billing service
from services.enterprise_billing import enterprise_billing


async def check_billing_status_unified(client, account_id: str) -> Tuple[bool, str, Optional[Dict]]:
    """
    Unified billing status check that routes to the appropriate billing system.
    
    When ENTERPRISE_MODE is enabled: ALL accounts use enterprise billing
    When ENTERPRISE_MODE is disabled: All accounts use Stripe billing
    
    Args:
        client: Supabase client (maintained for API compatibility)
        account_id: The basejump account ID to check
        
    Returns:
        Tuple[bool, str, Optional[Dict]]: (can_run, message, subscription_info)
    """
    try:
        # If enterprise mode is enabled, ALL accounts are enterprise accounts
        if config.ENTERPRISE_MODE:
            logger.debug(f"Enterprise mode enabled, using enterprise billing for account {account_id}")
            return await enterprise_billing.check_billing_status(account_id)
        else:
            # Enterprise mode disabled, use Stripe
            logger.debug(f"Enterprise mode disabled, using Stripe billing for account {account_id}")
            return await stripe_check_billing_status(client, account_id)
            
    except Exception as e:
        logger.error(
            f"Error in unified billing status check for account {account_id}: {e}",
            account_id=account_id,
            error=str(e),
            exc_info=True
        )
        # Fall back to Stripe billing on error
        try:
            return await stripe_check_billing_status(client, account_id)
        except Exception as fallback_error:
            logger.error(f"Fallback to Stripe billing also failed: {fallback_error}")
            return False, f"Billing system error: {str(e)}", None


async def handle_usage_unified(
    client,
    account_id: str,
    token_cost: float,
    thread_id: str = None,
    message_id: str = None,
    model: str = None,
    prompt_tokens: int = None,
    completion_tokens: int = None
) -> Tuple[bool, str]:
    """
    Unified usage handling that routes to the appropriate billing system.
    
    When ENTERPRISE_MODE is enabled: ALL accounts use enterprise credits
    When ENTERPRISE_MODE is disabled: All accounts use Stripe billing
    
    Args:
        client: Supabase client (maintained for API compatibility)
        account_id: The basejump account ID
        token_cost: Cost in dollars to charge
        thread_id: Optional thread ID for tracking
        message_id: Optional message ID for tracking
        model: Optional model name for tracking
        prompt_tokens: Optional prompt tokens count for detailed tracking
        completion_tokens: Optional completion tokens count for detailed tracking
        
    Returns:
        Tuple[bool, str]: (success, message)
    """
    try:
        # If enterprise mode is enabled, ALL accounts use enterprise credits
        if config.ENTERPRISE_MODE:
            logger.debug(
                f"Enterprise mode enabled, using enterprise credits for account {account_id}",
                account_id=account_id,
                token_cost=token_cost,
                thread_id=thread_id,
                message_id=message_id,
                model=model
            )
            
            # Calculate total tokens for enterprise billing
            total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)
            
            return await enterprise_billing.use_enterprise_credits(
                account_id=account_id,
                amount=token_cost,
                thread_id=thread_id,
                message_id=message_id,
                model_name=model,
                tokens_used=total_tokens if total_tokens > 0 else None
            )
        else:
            # Enterprise mode disabled, use Stripe
            logger.debug(f"Enterprise mode disabled, using Stripe billing for usage tracking")
            return await stripe_handle_usage_with_credits(
                client, account_id, token_cost, thread_id, message_id, model
            )
            
    except Exception as e:
        logger.error(
            f"Error in unified usage handling for account {account_id}: {e}",
            account_id=account_id,
            token_cost=token_cost,
            error=str(e),
            exc_info=True
        )
        
        # Fall back to Stripe billing on error
        try:
            return await stripe_handle_usage_with_credits(
                client, account_id, token_cost, thread_id, message_id, model
            )
        except Exception as fallback_error:
            logger.error(f"Fallback to Stripe usage handling also failed: {fallback_error}")
            return False, f"Usage tracking error: {str(e)}"


async def can_use_model_unified(client, account_id: str, model_name: str) -> Tuple[bool, str, Optional[list]]:
    """
    Unified model access check that routes to the appropriate billing system.
    
    When ENTERPRISE_MODE is enabled: ALL accounts get full model access
    When ENTERPRISE_MODE is disabled: Standard Stripe-based model access logic
    
    Args:
        client: Supabase client
        account_id: The basejump account ID
        model_name: The model name to check access for
        
    Returns:
        Tuple[bool, str, Optional[list]]: (can_use, message, allowed_models)
    """
    try:
        # If enterprise mode is enabled, ALL accounts get full model access
        if config.ENTERPRISE_MODE:
            logger.debug(f"Enterprise mode enabled - account {account_id} has full model access")
            return True, "Enterprise account - full model access", None
        else:
            # Use standard Stripe model access logic
            return await stripe_can_use_model(client, account_id, model_name)
        
    except Exception as e:
        logger.error(
            f"Error checking model access for account {account_id}: {e}",
            account_id=account_id,
            model_name=model_name,
            error=str(e),
            exc_info=True
        )
        # Fall back to Stripe logic on error
        try:
            return await stripe_can_use_model(client, account_id, model_name)
        except Exception as fallback_error:
            logger.error(f"Fallback model access check also failed: {fallback_error}")
            return False, f"Model access check error: {str(e)}", None


async def get_billing_info_unified(client, account_id: str) -> Dict[str, Any]:
    """
    Get comprehensive billing information for an account.
    
    When ENTERPRISE_MODE is enabled: Returns enterprise billing info for ALL accounts
    When ENTERPRISE_MODE is disabled: Returns Stripe billing info
    
    Args:
        client: Supabase client
        account_id: The basejump account ID
        
    Returns:
        Dict containing billing information
    """
    try:
        billing_info = {
            'account_id': account_id,
            'enterprise_mode_enabled': config.ENTERPRISE_MODE
        }
        
        if config.ENTERPRISE_MODE:
            # ALL accounts use enterprise billing
            user_limit = await enterprise_billing.get_user_limit(account_id)
            enterprise_balance = await enterprise_billing.get_enterprise_balance()
            
            billing_info.update({
                'billing_type': 'enterprise',
                'credit_balance': enterprise_balance['credit_balance'] if enterprise_balance else 0,
                'monthly_limit': user_limit['monthly_limit'] if user_limit else await enterprise_billing.get_default_monthly_limit(),
                'current_usage': user_limit['current_month_usage'] if user_limit else 0,
                'remaining_monthly': (user_limit['monthly_limit'] - user_limit['current_month_usage']) if user_limit else await enterprise_billing.get_default_monthly_limit(),
                'is_active': user_limit['is_active'] if user_limit else True
            })
        else:
            # Use Stripe billing
            can_run, message, subscription = await stripe_check_billing_status(client, account_id)
            billing_info.update({
                'billing_type': 'stripe',
                'can_run': can_run,
                'message': message,
                'subscription': subscription
            })
        
        return billing_info
        
    except Exception as e:
        logger.error(
            f"Error getting unified billing info for account {account_id}: {e}",
            account_id=account_id,
            error=str(e),
            exc_info=True
        )
        return {
            'account_id': account_id,
            'billing_type': 'error',
            'error': str(e)
        }


async def can_user_afford_tool_unified(client, account_id: str, tool_name: str) -> Dict[str, Any]:
    """
    Unified tool affordability check that routes to the appropriate billing system.
    
    When ENTERPRISE_MODE is enabled: Check individual tool costs against enterprise credits and user limits
    When ENTERPRISE_MODE is disabled: Use standard tool credit checking logic
    
    Args:
        client: Supabase client
        account_id: The basejump account ID
        tool_name: The tool name to check affordability for
        
    Returns:
        Dict containing affordability info: {'can_use': bool, 'required_cost': float, 'current_balance': float, 'user_remaining': float}
    """
    try:
        # If enterprise mode is enabled, use enterprise tool affordability check
        if config.ENTERPRISE_MODE:
            logger.debug(f"Enterprise mode enabled - checking enterprise tool affordability for {tool_name} by account {account_id}")
            
            # Use the new enterprise tool affordability function
            result = await client.rpc('enterprise_can_use_tool', {
                'p_account_id': account_id,
                'p_tool_name': tool_name
            }).execute()
            
            if result.data and len(result.data) > 0:
                data = result.data[0]
                return {
                    'can_use': data['can_use'],
                    'required_cost': float(data['required_cost']),
                    'current_balance': float(data['current_balance']),
                    'user_remaining': float(data['user_remaining'])
                }
            else:
                # Fallback if no data returned
                logger.warning(f"No data returned from enterprise_can_use_tool for {tool_name}")
                return {'can_use': False, 'required_cost': 0.0, 'current_balance': 0.0, 'user_remaining': 0.0}
        else:
            # Enterprise mode disabled, use standard tool credit checking
            logger.debug(f"Enterprise mode disabled, using standard tool credit checking for {tool_name}")
            return await stripe_can_user_afford_tool(client, account_id, tool_name)
        
    except Exception as e:
        logger.error(
            f"Error in unified tool affordability check for account {account_id} and tool {tool_name}: {e}",
            account_id=account_id,
            tool_name=tool_name,
            error=str(e),
            exc_info=True
        )
        # Fall back to standard logic on error
        try:
            return await stripe_can_user_afford_tool(client, account_id, tool_name)
        except Exception as fallback_error:
            logger.error(f"Fallback tool affordability check also failed: {fallback_error}")
            # Default to allowing tool use if both checks fail
            return {'can_use': True, 'required_cost': 0.0, 'current_balance': 0.0}


async def charge_tool_usage_unified(
    client,
    account_id: str,
    tool_name: str,
    thread_id: str = None,
    message_id: str = None
) -> Dict[str, Any]:
    """
    Unified tool usage charging that routes to the appropriate billing system.
    
    When ENTERPRISE_MODE is enabled: Charge individual tool costs from enterprise credits
    When ENTERPRISE_MODE is disabled: Use standard tool credit charging logic
    
    Args:
        client: Supabase client
        account_id: The basejump account ID
        tool_name: The tool name to charge for
        thread_id: Optional thread ID for tracking
        message_id: Optional message ID for tracking
        
    Returns:
        Dict containing charge result: {'success': bool, 'cost_charged': float, 'new_balance': float, 'user_remaining': float}
    """
    try:
        # If enterprise mode is enabled, use enterprise tool charging
        if config.ENTERPRISE_MODE:
            logger.debug(f"Enterprise mode enabled - charging tool {tool_name} from enterprise credits for account {account_id}")
            
            # Use the new enterprise tool charging function
            result = await client.rpc('enterprise_use_tool_credits', {
                'p_account_id': account_id,
                'p_tool_name': tool_name,
                'p_thread_id': thread_id,
                'p_message_id': message_id
            }).execute()
            
            if result.data and len(result.data) > 0:
                data = result.data[0]
                return {
                    'success': data['success'],
                    'cost_charged': float(data['cost_charged']),
                    'new_balance': float(data['new_balance']),
                    'user_remaining': float(data['user_remaining'])
                }
            else:
                logger.error(f"No data returned from enterprise_use_tool_credits for {tool_name}")
                return {'success': False, 'cost_charged': 0.0, 'new_balance': 0.0, 'user_remaining': 0.0}
        else:
            # Enterprise mode disabled, use standard tool charging
            logger.debug(f"Enterprise mode disabled, charging for tool {tool_name} usage")
            return await stripe_charge_tool_usage(client, account_id, tool_name, thread_id, message_id)
        
    except Exception as e:
        logger.error(
            f"Error in unified tool usage charging for account {account_id} and tool {tool_name}: {e}",
            account_id=account_id,
            tool_name=tool_name,
            error=str(e),
            exc_info=True
        )
        # Fall back to standard logic on error
        try:
            return await stripe_charge_tool_usage(client, account_id, tool_name, thread_id, message_id)
        except Exception as fallback_error:
            logger.error(f"Fallback tool charging also failed: {fallback_error}")
            # Default to success if both fail
            return {'success': True, 'cost_charged': 0.0, 'new_balance': 0.0}


# Maintain backward compatibility by exposing unified functions with original names
check_billing_status = check_billing_status_unified
handle_usage_with_credits = handle_usage_unified
can_use_model = can_use_model_unified
can_user_afford_tool = can_user_afford_tool_unified
charge_tool_usage = charge_tool_usage_unified
