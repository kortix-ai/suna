from fastapi import APIRouter, HTTPException, Depends, Header
from pydantic import BaseModel
from typing import Optional
import os
from core.services.email import email_service
from core.utils.logger import logger

router = APIRouter(tags=["email"])

class EmailResponse(BaseModel):
    success: bool
    message: str

class SupabaseWebhookPayload(BaseModel):
    """Payload from Supabase webhook on auth.users insert"""
    type: str
    table: str
    record: dict
    schema: str
    old_record: Optional[dict] = None

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

@router.post("/webhooks/user-created", response_model=EmailResponse)
async def handle_user_created_webhook(
    payload: SupabaseWebhookPayload,
    _: bool = Depends(verify_webhook_secret)
):
    """
    Webhook endpoint called by Supabase when a new user is created.
    This eliminates the need for frontend to trigger welcome emails.
    """
    try:
        if payload.type != "INSERT" or payload.table != "users":
            return EmailResponse(
                success=False,
                message="Invalid webhook payload"
            )
        
        user_record = payload.record
        email = user_record.get('email')
        
        if not email:
            logger.warning("User created webhook received without email")
            return EmailResponse(
                success=False,
                message="No email in user record"
            )
        
        # Extract user name from metadata or email
        raw_user_metadata = user_record.get('raw_user_meta_data', {})
        user_name = (
            raw_user_metadata.get('full_name') or 
            raw_user_metadata.get('name') or
            email.split('@')[0].replace('.', ' ').replace('_', ' ').replace('-', ' ').title()
        )
        
        logger.info(f"📧 Sending welcome email to new user: {email}")
        
        # Send email asynchronously
        def send_email():
            return email_service.send_welcome_email(
                user_email=email,
                user_name=user_name
            )
        
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as executor:
            future = executor.submit(send_email)
        
        return EmailResponse(
            success=True,
            message="Welcome email queued"
        )
            
    except Exception as e:
        logger.error(f"Error handling user created webhook: {str(e)}")
        # Don't raise exception - we don't want to break user signup if email fails
        return EmailResponse(
            success=False,
            message=str(e)
        )

