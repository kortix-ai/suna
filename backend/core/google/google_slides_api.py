"""
Google Slides Integration API

Consolidated API router that handles both OAuth flow and presentation conversion endpoints.
Combines functionality from google_oauth_router.py and presentation_tools_api.py.

Endpoints:
- OAuth: GET /google/auth-url, GET /google/callback, POST /google/disconnect  
- Presentations: POST /presentation-tools/convert-and-upload-to-slides
"""

import os
import httpx
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Depends
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.services.supabase import DBConnection
from .google_slides_service import GoogleSlidesService, OAuthTokenService


# ================== PYDANTIC MODELS ==================

class AuthURLResponse(BaseModel):
    auth_url: str
    message: str


# UNUSED: AuthStatusResponse - no auth status endpoint exists
# class AuthStatusResponse(BaseModel):
#     is_authenticated: bool
#     message: str


# UNUSED: CallbackResponse - callback returns redirect, not JSON
# class CallbackResponse(BaseModel):
#     success: bool
#     message: str
#     redirect_url: Optional[str] = None


class ConvertToSlidesRequest(BaseModel):
    presentation_path: str = Field(..., description="Path to the presentation in sandbox (e.g., /workspace/presentations/my-pres)")
    sandbox_url: str = Field(..., description="Sandbox URL to fetch the PPTX from")


class ConvertToSlidesResponse(BaseModel):
    success: bool
    message: str
    pptx_url: Optional[str] = None
    google_slides_url: Optional[str] = None
    google_slides_file_id: Optional[str] = None
    is_api_enabled: bool = None


# ================== DEPENDENCY INJECTION ==================

async def get_db_connection() -> DBConnection:
    """Get database connection."""
    db = DBConnection()
    await db.initialize()
    return db


async def get_oauth_service(db: DBConnection = Depends(get_db_connection)) -> OAuthTokenService:
    """Get OAuth token service with database connection."""
    return OAuthTokenService(db)


async def get_google_slides_service(oauth_service: OAuthTokenService = Depends(get_oauth_service)) -> GoogleSlidesService:
    """Get Google Slides service with OAuth token service."""
    return GoogleSlidesService(oauth_service)


# ================== ROUTER SETUP ==================

# Create a main router that will include sub-routers for different prefixes
main_router = APIRouter()

# Create sub-routers for different endpoint groups
oauth_router = APIRouter(prefix="/google", tags=["google-oauth"])
presentation_router = APIRouter(prefix="/presentation-tools", tags=["presentation-tools"])


# ================== OAUTH ENDPOINTS ==================

@oauth_router.get("/auth-url", response_model=AuthURLResponse)
async def get_google_auth_url(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    return_url: Optional[str] = Query(None, description="URL to redirect to after OAuth"),
    google_service: GoogleSlidesService = Depends(get_google_slides_service)
):
    """
    Generate Google OAuth consent URL for the authenticated user
    
    Args:
        user_id: User identifier from JWT authentication
        return_url: Optional URL to redirect to after successful OAuth
        google_service: Injected Google Slides service
    
    Returns:
        OAuth consent URL that user should visit
    """
    try:
        auth_url = google_service.get_auth_url(user_id, return_url)
        
        return AuthURLResponse(
            auth_url=auth_url,
            message="Visit this URL to authenticate with Google"
        )
        
    except Exception as e:
        logger.error(f"Failed to generate auth URL: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@oauth_router.get("/callback")
async def google_oauth_callback(
    code: Optional[str] = Query(None, description="Authorization code from Google"),
    state: Optional[str] = Query(None, description="State parameter (contains user_id)"),
    error: Optional[str] = Query(None, description="Error from Google OAuth"),
    google_service: GoogleSlidesService = Depends(get_google_slides_service)
):
    """
    Handle Google OAuth callback
    
    This endpoint receives the authorization code from Google and exchanges it for tokens.
    Redirects to the frontend with success/error status.
    """
    # Get frontend URL from environment (supports different environments)
    frontend_url = os.getenv("FRONTEND_URL")
    
    if error:
        logger.error(f"Google OAuth error: {error}")
        return RedirectResponse(url=f"{frontend_url}?google_auth=error&error={error}")
    
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing authorization code or state")
    
    # Extract user_id from state (will be updated when service is modified)
    user_id = state.split(':')[0]  # State format: user_id:uuid or user_id:uuid:return_url
    
    try:
        tokens, return_url = await google_service.handle_oauth_callback(code, state)
        
        logger.info(f"Successfully authenticated user {user_id} with Google")
        
        # Use the return URL from state if available, otherwise default to frontend root
        if return_url:
            # Ensure return_url is from the same domain for security
            if return_url.startswith(frontend_url):
                redirect_url = f"{return_url}?google_auth=success"
            else:
                logger.warning(f"Return URL {return_url} not from same domain as {frontend_url}, using default")
                redirect_url = f"{frontend_url}?google_auth=success"
        else:
            redirect_url = f"{frontend_url}?google_auth=success"
        
        return RedirectResponse(url=redirect_url)
        
    except Exception as e:
        logger.error(f"Failed to exchange authorization code: {e}", exc_info=True)
        return RedirectResponse(url=f"{frontend_url}?google_auth=error&error=auth_failed")


# UNUSED: Disconnect endpoint - frontend never calls this
# @oauth_router.post("/disconnect")
# async def disconnect_google(
#     user_id: str = Depends(verify_and_get_user_id_from_jwt),
#     google_service: GoogleSlidesService = Depends(get_google_slides_service)
# ):
#     """
#     Disconnect authenticated user from Google (remove stored tokens)
#     
#     Args:
#         user_id: User identifier from JWT authentication
#         google_service: Injected Google Slides service
#     """
#     try:
#         result = await google_service.disconnect_user(user_id)
#         return result
#         
#     except Exception as e:
#         logger.error(f"Failed to disconnect user: {e}")
#         raise HTTPException(status_code=500, detail=str(e))


# ================== PRESENTATION ENDPOINTS ==================

@presentation_router.post("/convert-and-upload-to-slides", response_model=ConvertToSlidesResponse)
async def convert_and_upload_to_google_slides(
    request: ConvertToSlidesRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    google_service: GoogleSlidesService = Depends(get_google_slides_service)
):
    """
    Convert HTML presentation to PPTX and upload to Google Slides
    
    Flow:
    1. Call sandbox to convert HTML → PPTX
    2. Download PPTX from sandbox  
    3. Upload PPTX to Google Slides using authenticated user's credentials
    4. Return both local and Google Slides URLs
    """
    
    try:
        logger.info(f"Starting presentation conversion and upload for user {user_id}")
        
        # Step 1: Check if user is authenticated with Google
        if not await google_service.is_user_authenticated(user_id):
            return ConvertToSlidesResponse(
                success=False,
                message="User not authenticated with Google. Please authenticate first.",
                pptx_url=None,
                is_api_enabled=False
            )
        
        # Step 2: Call sandbox to convert HTML to PPTX
        logger.debug(f"Converting presentation at {request.presentation_path}")
        
        async with httpx.AsyncClient(timeout=120.0) as client:
            convert_response = await client.post(
                f"{request.sandbox_url}/presentation/convert-to-pptx",
                json={
                    "presentation_path": request.presentation_path,
                    "download": True,  # Get PPTX content directly, don't store locally
                    "upload_to_google_slides": False,  # We'll handle Google upload from main backend
                }
            )
            
            if not convert_response.is_success:
                try:
                    error_detail = convert_response.json().get("detail", "Unknown error")
                except:
                    error_detail = convert_response.text
                raise HTTPException(
                    status_code=convert_response.status_code,
                    detail=f"PPTX conversion failed: {error_detail}"
                )
            
            # When download=True, we get the PPTX file content directly
            pptx_content = convert_response.content
            
            # Extract filename from Content-Disposition header
            filename = "presentation.pptx"  # default
            content_disposition = convert_response.headers.get("Content-Disposition", "")
            if "filename=" in content_disposition:
                filename = content_disposition.split('filename="')[1].split('"')[0]
        
        logger.debug(f"PPTX conversion successful: {filename}")
        
        with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as temp_file:
            temp_pptx_path = Path(temp_file.name)
            temp_file.write(pptx_content)
            temp_file.flush()  # Ensure data is written to disk
        
        logger.debug(f"Saved PPTX to temporary file: {temp_pptx_path} (size: {len(pptx_content)} bytes)")
        
        try:
            # Step 3: Upload PPTX to Google Slides
            logger.debug("Uploading PPTX to Google Slides")
            
            # Extract presentation name from filename (remove timestamp and extension)
            presentation_name = filename.replace(".pptx", "").split("_")[0] if "_" in filename else filename.replace(".pptx", "")
            
            upload_result = await google_service.upload_pptx_to_slides(
                pptx_file_path=temp_pptx_path,
                user_id=user_id,
                presentation_name=presentation_name
            )
            logger.info(f"Successfully uploaded to Google Slides: {upload_result['web_view_link']}")
            
            return ConvertToSlidesResponse(
                success=True,
                message=f"Successfully converted and uploaded to Google Slides",
                pptx_url=None,  # No local URL since we generated content live
                google_slides_url=upload_result["web_view_link"],
                google_slides_file_id=upload_result["file_id"]
            )
            
        finally:
            # Clean up temporary file
            try:
                temp_pptx_path.unlink()
            except:
                pass  # Ignore cleanup errors
    
    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        logger.error(f"Error in convert_and_upload_to_google_slides: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


# ================== ROUTER ASSEMBLY ==================

# Include both sub-routers in the main router
main_router.include_router(oauth_router)
main_router.include_router(presentation_router)

# Export the main router as 'router' for backward compatibility
router = main_router
