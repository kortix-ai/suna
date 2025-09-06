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
    can_use_model as stripe_can_use_model
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
    model: str = None
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
            
            return await enterprise_billing.use_enterprise_credits(
                account_id=account_id,
                amount=token_cost,
                thread_id=thread_id,
                message_id=message_id,
                model_name=model
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
                'monthly_limit': user_limit['monthly_limit'] if user_limit else 1000.00,
                'current_usage': user_limit['current_month_usage'] if user_limit else 0,
                'remaining_monthly': (user_limit['monthly_limit'] - user_limit['current_month_usage']) if user_limit else 1000.00,
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


# Maintain backward compatibility by exposing unified functions with original names
check_billing_status = check_billing_status_unified
handle_usage_with_credits = handle_usage_unified
can_use_model = can_use_model_unified
