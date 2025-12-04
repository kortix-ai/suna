import hmac
from fastapi import APIRouter, Depends, HTTPException, Header, BackgroundTasks
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
    """Verify the webhook secret from Supabase using constant-time comparison."""
    expected_secret = os.getenv('SUPABASE_WEBHOOK_SECRET')
    if not expected_secret:
        logger.error("SUPABASE_WEBHOOK_SECRET not configured")
        raise HTTPException(status_code=500, detail="Webhook secret not configured")
    
    # Use constant-time comparison to prevent timing attacks
    if not hmac.compare_digest(x_webhook_secret.encode('utf-8'), expected_secret.encode('utf-8')):
        logger.warning("Invalid webhook secret received")
        raise HTTPException(status_code=401, detail="Invalid webhook secret")
    
    return True

# ============================================================================
# Helper Functions
# ============================================================================

async def initialize_user_account(account_id: str, email: Optional[str] = None, user_record: Optional[dict] = None) -> Dict:
    try:
        logger.info(f"[SETUP] Initializing account for {account_id}")
        
        db = DBConnection()
        await db.initialize()

        user_name = None
        if user_record and email:
            user_name = _extract_user_name(user_record, email)
        

        from core.notifications.notification_service import notification_service

        logger.info(f"[SETUP] Sending welcome email to {email} with name {user_name}")
        try:
            await notification_service.send_welcome_email(account_id)
            
        except Exception as ex:
            logger.error(f"[SETUP] Error sending welcome notification: {ex}")
            if email and user_name:
                _send_welcome_email_async(email, user_name)
        
        result = await free_tier_service.auto_subscribe_to_free_tier(account_id, email)
        
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
        
        logger.info(f"[SETUP] Installing Suna agent for {account_id}")
        suna_service = SunaDefaultAgentService(db)
        agent_id = await suna_service.install_suna_agent_for_user(account_id)
        

        if not agent_id:
            logger.warning(f"[SETUP] Failed to install Suna agent for {account_id}, but continuing")
        
        if user_record:
            raw_user_metadata = user_record.get('raw_user_meta_data', {})
            referral_code = raw_user_metadata.get('referral_code')
            
            logger.info(f"[SETUP] User metadata: {raw_user_metadata}")
            logger.info(f"[SETUP] Referral code from metadata: {referral_code}")
            
            if referral_code:
                logger.info(f"[SETUP] Processing referral code for {account_id}: {referral_code}")
                try:
                    from core.referrals.service import ReferralService
                    
                    referral_service = ReferralService(db)
                    referrer_id = await referral_service.validate_referral_code(referral_code)
                    logger.info(f"[SETUP] Validated referral code {referral_code} -> referrer_id: {referrer_id}")
                    
                    if referrer_id and referrer_id != account_id:
                        referral_result = await referral_service.process_referral(
                            referrer_id=referrer_id,
                            referred_account_id=account_id,
                            referral_code=referral_code
                        )
                        
                        logger.info(f"[SETUP] Referral processing result: {referral_result}")
                        
                        if referral_result.get('success'):
                            logger.info(
                                f"[SETUP] ✅ Referral processed: {referrer_id} referred {account_id}, "
                                f"awarded {referral_result.get('credits_awarded')} credits"
                            )
                        else:
                            logger.warning(
                                f"[SETUP] Failed to process referral: {referral_result.get('message')}"
                            )
                    else:
                        logger.warning(
                            f"[SETUP] Invalid referral code or self-referral: {referral_code}, "
                            f"referrer_id={referrer_id}, new_user_id={account_id}"
                        )
                except Exception as ref_error:
                    logger.error(f"[SETUP] Error processing referral: {ref_error}", exc_info=True)
        
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
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    email = None
    user_record = None
    
    try:
        user_response = await client.auth.admin.get_user_by_id(account_id)
        if user_response and hasattr(user_response, 'user') and user_response.user:
            user = user_response.user
            email = user.email
            user_record = {
                'id': user.id,
                'email': user.email,
                'raw_user_meta_data': user.user_metadata or {}
            }
    except Exception as e:
        logger.warning(f"[SETUP] Could not fetch user for initialization: {e}")
    
    result = await initialize_user_account(account_id, email, user_record)
    
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

        account_id = user_id
        init_result = await initialize_user_account(account_id, email, user_record)
        
        if init_result.get('success'):
            logger.info(
                f"✅ Account initialized for {email}: "
                f"subscription={init_result.get('subscription_id')}, "
                f"agent={init_result.get('agent_id')}"
            )
        else:
            error_msg = init_result.get('message', 'Unknown error')
            logger.error(f"⚠️ Account initialization failed for {email}: {error_msg}")
        
        return WebhookResponse(
            success=True,
            message=f"User created webhook processed. Initialization: {'success' if init_result.get('success') else 'failed'}"
        )
            
    except Exception as e:
        logger.error(f"Error handling user created webhook: {str(e)}")
        return WebhookResponse(
            success=False,
            message=str(e)
        )
