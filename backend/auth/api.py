"""
Auth API - OTP Email Endpoint

Provides an endpoint to send OTP-only emails for users who experience
magic link expiration due to email security scanners (e.g., Microsoft Defender).
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr
import httpx
import os
from core.utils.logger import logger
from core.utils.config import config
from core.services.email import email_service

router = APIRouter(prefix="/auth", tags=["auth"])


class SendOtpRequest(BaseModel):
    email: EmailStr


class SendOtpResponse(BaseModel):
    success: bool
    message: str


@router.post("/send-otp", response_model=SendOtpResponse)
async def send_otp_email(request: SendOtpRequest):
    """
    Generate a new OTP and send it via custom email (no magic link).

    This endpoint is used when a user's magic link has expired due to
    email security scanners pre-fetching the link.

    Flow:
    1. Call Supabase Admin API to generate a magic link (creates new token)
    2. Extract the OTP token from the response
    3. Send custom email via Mailtrap with just the OTP code (no clickable link)
    """
    try:
        email = request.email.lower().strip()

        # Call Supabase Admin API to generate link
        supabase_url = config.SUPABASE_URL
        service_role_key = config.SUPABASE_SERVICE_ROLE_KEY

        if not supabase_url or not service_role_key:
            logger.error("Supabase configuration missing")
            raise HTTPException(status_code=500, detail="Server configuration error")

        # Generate magic link via Admin API
        # This creates a new token and returns the OTP code
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{supabase_url}/auth/v1/admin/generate_link",
                headers={
                    "Authorization": f"Bearer {service_role_key}",
                    "apikey": service_role_key,
                    "Content-Type": "application/json"
                },
                json={
                    "type": "magiclink",
                    "email": email
                },
                timeout=30.0
            )

            if response.status_code != 200:
                error_detail = response.text
                logger.error(f"Supabase generate_link failed: {response.status_code} - {error_detail}")

                # Check for specific error - user might not exist
                if "User not found" in error_detail:
                    raise HTTPException(status_code=404, detail="No account found with this email")

                raise HTTPException(status_code=500, detail="Failed to generate verification code")

            data = response.json()

        # Extract the OTP token from the response
        # Supabase may return email_otp at top level or in properties
        otp_token = data.get("email_otp")
        if not otp_token:
            properties = data.get("properties", {})
            otp_token = properties.get("email_otp")

        if not otp_token:
            logger.warning(f"No email_otp in response. Keys: {list(data.keys())}")

            # If we can't get the OTP, we can't proceed with custom email
            # Fall back to telling the user to check their email (Supabase might have sent one)
            raise HTTPException(
                status_code=500,
                detail="Unable to generate verification code. Please try the magic link in your email."
            )

        # Send custom email with OTP code via Mailtrap
        success = email_service.send_otp_email(
            user_email=email,
            otp_code=otp_token
        )

        if not success:
            logger.error(f"Failed to send OTP email to {email}")
            raise HTTPException(status_code=500, detail="Failed to send verification email")

        logger.info(f"OTP email sent successfully to {email}")

        return SendOtpResponse(
            success=True,
            message="Verification code sent to your email"
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in send_otp_email: {str(e)}")
        raise HTTPException(status_code=500, detail="An error occurred")
