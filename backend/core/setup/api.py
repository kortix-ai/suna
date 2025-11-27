from fastapi import APIRouter, Depends, HTTPException, Header # type: ignore
from pydantic import BaseModel
from typing import Dict, Optional
import os
import concurrent.futures
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.billing.subscriptions import free_tier_service
from core.utils.suna_default_agent_service import SunaDefaultAgentService
from core.services.supabase import DBConnection
from core.services.email import email_service

# Main setup router (prefix="/setup")
router = APIRouter(prefix="/setup", tags=["setup"])

# Webhook router (no prefix - webhooks are at /api/webhooks/*)
webhook_router = APIRouter(tags=["webhooks"])

# ============================================================================
# Models
# ============================================================================

class WebhookResponse(BaseModel):
    """Response model for webhook endpoints"""
    success: bool
    message: str

class SupabaseWebhookPayload(BaseModel):
    """Payload from Supabase webhook on auth.users insert"""
    type: str
    table: str
    record: dict
    schema: str
    old_record: Optional[dict] = None

# ============================================================================
# Webhook Security
# ============================================================================

def verify_webhook_secret(x_webhook_secret: str = Header(...)):
    """Verify the webhook secret from Supabase"""
    expected_secret = os.getenv('SUPABASE_WEBHOOK_SECRET')
    if not expected_secret:
        logger.error("SUPABASE_WEBHOOK_SECRET not configured")
        raise HTTPException(status_code=500, detail="Webhook secret not configured")
    
    if x_webhook_secret != expected_secret:
        logger.warning("Invalid webhook secret received")
        raise HTTPException(status_code=401, detail="Invalid webhook secret")
    
    return True

# ============================================================================
# Helper Functions
# ============================================================================

async def initialize_user_account(account_id: str, email: Optional[str] = None) -> Dict:
    """
    Reusable function to initialize a user account:
    1. Subscribe to free tier
    2. Install default Suna agent
    
    This can be called from:
    - Webhook (automatic on signup - triggered by database trigger)
    - API endpoint (fallback/retry)
    
    Args:
        account_id: The user's account ID (UUID)
        email: Optional email address (will be fetched if not provided)
    
    Returns:
        Dict with 'success', 'message', and optionally 'subscription_id'
    """
    try:
        logger.info(f"[SETUP] Initializing account for {account_id}")
        
        db = DBConnection()
        await db.initialize()
        
        # Subscribe to free tier
        result = await free_tier_service.auto_subscribe_to_free_tier(account_id, email)
        
        # Check if already subscribed (not an error)
        if not result.get('success'):
            error_msg = result.get('error') or result.get('message', 'Unknown error')
            if 'Already subscribed' in error_msg or 'already' in error_msg.lower():
                logger.info(f"[SETUP] User {account_id} already has subscription, proceeding with agent install")
            else:
                logger.error(f"[SETUP] Failed to create free tier for {account_id}: {error_msg}")
                return {
                    'success': False,
                    'message': f"Failed to initialize free tier: {error_msg}",
                    'error': error_msg
                }
        
        # Install Suna agent
        logger.info(f"[SETUP] Installing Suna agent for {account_id}")
        suna_service = SunaDefaultAgentService(db)
        agent_id = await suna_service.install_suna_agent_for_user(account_id)
        
        if not agent_id:
            logger.warning(f"[SETUP] Failed to install Suna agent for {account_id}, but continuing")
        
        logger.info(f"[SETUP] ✅ Account initialization complete for {account_id}")
        
        return {
            'success': True,
            'message': 'Account initialized successfully',
            'subscription_id': result.get('subscription_id'),
            'agent_id': agent_id
        }
        
    except Exception as e:
        logger.error(f"[SETUP] Error initializing account {account_id}: {e}")
        return {
            'success': False,
            'message': str(e),
            'error': str(e)
        }

def _extract_user_name(user_record: dict, email: str) -> str:
    """Extract user name from metadata or email"""
    raw_user_metadata = user_record.get('raw_user_meta_data', {})
    return (
        raw_user_metadata.get('full_name') or 
        raw_user_metadata.get('name') or
        email.split('@')[0].replace('.', ' ').replace('_', ' ').replace('-', ' ').title()
    )

def _send_welcome_email_async(email: str, user_name: str):
    """Send welcome email asynchronously (non-blocking)"""
    try:
        return email_service.send_welcome_email(
            user_email=email,
            user_name=user_name
        )
    except Exception as e:
        logger.error(f"Failed to send welcome email to {email}: {e}")
        return None

# ============================================================================
# API Endpoints
# ============================================================================

@router.post("/initialize")
async def initialize_account(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    API endpoint for account initialization (fallback/retry).
    Most users will be initialized automatically via webhook on signup.
    """
    result = await initialize_user_account(account_id)
    
    if not result.get('success'):
        raise HTTPException(status_code=500, detail=result.get('message', 'Failed to initialize account'))
    
    return result

# ============================================================================
# Webhook Endpoints
# ============================================================================

@webhook_router.post("/webhooks/user-created", response_model=WebhookResponse)
async def handle_user_created_webhook(
    payload: SupabaseWebhookPayload,
    _: bool = Depends(verify_webhook_secret)
):
    """
    Webhook endpoint called by Supabase database trigger when a new user is created.
    
    This webhook is triggered automatically by a database trigger (trigger_welcome_email)
    when a new row is inserted into auth.users table. The trigger makes an HTTP POST
    request to this endpoint using pg_net.
    
    This webhook automatically:
    1. Initializes account (free tier subscription + Suna agent)
    2. Sends welcome email
    
    All initialization happens automatically on the backend, eliminating
    the need for client-side initialization calls.
    """
    try:
        # Validate payload
        if payload.type != "INSERT" or payload.table != "users":
            return WebhookResponse(
                success=False,
                message="Invalid webhook payload"
            )
        
        user_record = payload.record
        user_id = user_record.get('id')
        email = user_record.get('email')
        
        if not user_id:
            logger.warning("User created webhook received without user ID")
            return WebhookResponse(
                success=False,
                message="No user ID in user record"
            )
        
        if not email:
            logger.warning("User created webhook received without email")
            return WebhookResponse(
                success=False,
                message="No email in user record"
            )
        
        logger.info(f"🎉 New user signup: {email} (ID: {user_id})")
        
        # Extract user name for welcome email
        user_name = _extract_user_name(user_record, email)
        
        # Initialize account (free tier + Suna agent)
        # The account_id is the same as user_id for personal accounts (basejump pattern)
        account_id = user_id
        init_result = await initialize_user_account(account_id, email)
        
        if init_result.get('success'):
            logger.info(
                f"✅ Account initialized for {email}: "
                f"subscription={init_result.get('subscription_id')}, "
                f"agent={init_result.get('agent_id')}"
            )
        else:
            # Log error but don't fail - user can retry via /setup/initialize endpoint
            error_msg = init_result.get('message', 'Unknown error')
            logger.error(f"⚠️ Account initialization failed for {email}: {error_msg}")
            # Continue to send welcome email even if initialization failed
        
        # Send welcome email asynchronously (non-blocking)
        with concurrent.futures.ThreadPoolExecutor() as executor:
            executor.submit(_send_welcome_email_async, email, user_name)
        
        return WebhookResponse(
            success=True,
            message=f"User created webhook processed. Initialization: {'success' if init_result.get('success') else 'failed'}"
        )
            
    except Exception as e:
        logger.error(f"Error handling user created webhook: {str(e)}")
        # Don't raise exception - we don't want to break user signup
        return WebhookResponse(
            success=False,
            message=str(e)
        )

