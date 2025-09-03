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
    
    This function maintains the same signature as the original check_billing_status
    but automatically routes to either Stripe or Enterprise billing based on
    configuration and account status.
    
    Args:
        client: Supabase client (maintained for API compatibility)
        account_id: The basejump account ID to check
        
    Returns:
        Tuple[bool, str, Optional[Dict]]: (can_run, message, subscription_info)
    """
    try:
        # If enterprise mode is disabled, always use Stripe
        if not config.ENTERPRISE_MODE:
            logger.debug(f"Enterprise mode disabled, using Stripe billing for account {account_id}")
            return await stripe_check_billing_status(client, account_id)
        
        # Check if account is part of enterprise billing
        is_enterprise = await enterprise_billing.is_enterprise_account(account_id)
        
        if is_enterprise:
            logger.debug(f"Account {account_id} is enterprise, using enterprise billing")
            can_run, message, billing_info = await enterprise_billing.check_enterprise_billing_status(account_id)
            
            # Convert enterprise billing info to compatible format
            if billing_info:
                subscription_info = {
                    'type': 'enterprise',
                    'enterprise_id': billing_info.get('enterprise_id'),
                    'enterprise_name': billing_info.get('enterprise_name'),
                    'balance': billing_info.get('balance'),
                    'monthly_limit': billing_info.get('monthly_limit'),
                    'current_usage': billing_info.get('current_usage'),
                    'remaining_monthly': billing_info.get('remaining_monthly')
                }
            else:
                subscription_info = {'type': 'enterprise', 'error': message}
            
            return can_run, message, subscription_info
        else:
            logger.debug(f"Account {account_id} is not enterprise, using Stripe billing")
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
    
    This function maintains the same signature as handle_usage_with_credits
    but automatically routes to either Stripe or Enterprise billing.
    
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
        # If enterprise mode is disabled, always use Stripe
        if not config.ENTERPRISE_MODE:
            logger.debug(f"Enterprise mode disabled, using Stripe billing for usage tracking")
            return await stripe_handle_usage_with_credits(
                client, account_id, token_cost, thread_id, message_id, model
            )
        
        # Check if account is part of enterprise billing
        is_enterprise = await enterprise_billing.is_enterprise_account(account_id)
        
        if is_enterprise:
            logger.debug(
                f"Account {account_id} is enterprise, using enterprise billing for usage",
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
            logger.debug(
                f"Account {account_id} is not enterprise, using Stripe billing for usage",
                account_id=account_id,
                token_cost=token_cost
            )
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
    
    For now, this primarily uses the existing Stripe-based model access logic,
    but enterprise accounts get full model access regardless of subscription tier.
    
    Args:
        client: Supabase client
        account_id: The basejump account ID
        model_name: The model name to check access for
        
    Returns:
        Tuple[bool, str, Optional[list]]: (can_use, message, allowed_models)
    """
    try:
        # Check if enterprise mode is enabled and account is enterprise
        if config.ENTERPRISE_MODE:
            is_enterprise = await enterprise_billing.is_enterprise_account(account_id)
            
            if is_enterprise:
                # Enterprise accounts get access to all models
                logger.debug(f"Enterprise account {account_id} has full model access")
                return True, "Enterprise account - full model access", None
        
        # Fall back to standard model access logic for non-enterprise accounts
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
    
    This function provides a unified view of billing information whether the
    account uses Stripe or Enterprise billing.
    
    Args:
        client: Supabase client
        account_id: The basejump account ID
        
    Returns:
        Dict containing billing information
    """
    try:
        billing_info = {
            'account_id': account_id,
            'billing_type': 'stripe',  # Default
            'enterprise_mode_enabled': config.ENTERPRISE_MODE
        }
        
        # Check if enterprise mode is enabled and account is enterprise
        if config.ENTERPRISE_MODE:
            is_enterprise = await enterprise_billing.is_enterprise_account(account_id)
            
            if is_enterprise:
                # Get enterprise billing info
                enterprise_info = await enterprise_billing.get_user_enterprise_info(account_id)
                if enterprise_info:
                    billing_info.update({
                        'billing_type': 'enterprise',
                        'enterprise_id': enterprise_info.get('enterprise_id'),
                        'enterprise_name': enterprise_info.get('enterprise_name'),
                        'credit_balance': enterprise_info.get('credit_balance'),
                        'monthly_limit': enterprise_info.get('monthly_limit'),
                        'current_usage': enterprise_info.get('current_usage'),
                        'remaining_monthly': enterprise_info.get('remaining_monthly'),
                        'is_active': enterprise_info.get('is_active')
                    })
                return billing_info
        
        # For non-enterprise accounts, get Stripe billing info
        can_run, message, subscription = await stripe_check_billing_status(client, account_id)
        billing_info.update({
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
