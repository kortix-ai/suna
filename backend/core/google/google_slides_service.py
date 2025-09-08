"""
Google Slides Integration Service

Consolidated service module that handles both OAuth token management and Google Slides operations.
Combines functionality from oauth_token_service.py and google_slides.py.

Services:
- OAuthTokenService: Secure token storage and retrieval with encryption
- GoogleSlidesService: OAuth flow and Google Drive/Slides API operations
"""

import json
import uuid
import base64
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Any, Optional, List
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

from core.credentials.credential_service import EncryptionService
from core.services.supabase import DBConnection
from core.utils.logger import logger


# ================== DATA CLASSES AND EXCEPTIONS ==================

@dataclass(frozen=True)
class OAuthToken:
    """Represents a Google OAuth token for a user."""
    id: str
    user_id: str
    token_data: Dict[str, Any]  # Contains access_token, refresh_token, etc.
    expires_at: Optional[datetime] = None
    is_active: bool = True
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class OAuthTokenNotFoundError(Exception):
    """Raised when a requested OAuth token is not found."""
    pass


class OAuthTokenAccessDeniedError(Exception):
    """Raised when access to an OAuth token is denied."""
    pass


# ================== OAUTH TOKEN SERVICE ==================

class OAuthTokenService:
    """Service for managing OAuth tokens with encryption and secure storage."""
    
    def __init__(self, db_connection: DBConnection):
        self._db = db_connection
        self._encryption = EncryptionService()
        logger.debug("OAuthTokenService initialized")
    
    async def store_token(
        self,
        user_id: str,
        token_data: Dict[str, Any],
        expires_at: Optional[datetime] = None
    ) -> str:
        """
        Store or update Google OAuth token for a user.
        
        Args:
            user_id: User identifier
            token_data: Dict containing access_token, refresh_token, etc.
            expires_at: Token expiration time
            
        Returns:
            Token ID
        """
        logger.debug(f"Storing Google OAuth token for user {user_id}")
        
        # Encrypt the token data
        encrypted_token, token_hash = self._encryption.encrypt_config(token_data)
        encoded_token = base64.b64encode(encrypted_token).decode('utf-8')
        
        client = await self._db.client
        
        # Delete existing tokens for this user (hard delete for OAuth tokens)
        await client.table('google_oauth_tokens').delete()\
            .eq('user_id', user_id)\
            .execute()
        
        # Insert new token
        token_row = {
            'user_id': user_id,
            'encrypted_token': encoded_token,
            'token_hash': token_hash,
            'expires_at': expires_at.isoformat() if expires_at else None,
            'created_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        result = await client.table('google_oauth_tokens').insert(token_row).execute()
        
        token_id = result.data[0]['id']
        logger.debug(f"Stored Google OAuth token {token_id} for user {user_id}")
        return token_id
    
    async def get_token(
        self,
        user_id: str
    ) -> Optional[OAuthToken]:
        """
        Retrieve Google OAuth token for a user.
        
        Args:
            user_id: User identifier
            
        Returns:
            OAuthToken if found, None otherwise
        """
        client = await self._db.client
        result = await client.table('google_oauth_tokens').select('*')\
            .eq('user_id', user_id)\
            .order('created_at', desc=True)\
            .limit(1)\
            .execute()
        
        if not result.data:
            return None
        
        return self._map_to_oauth_token(result.data[0])
    
    # UNUSED: get_user_tokens - never called anywhere
    # async def get_user_tokens(self, user_id: str) -> List[OAuthToken]:
    #     """
    #     Get all active OAuth tokens for a user.
    #     
    #     Args:
    #         user_id: User identifier
    #         
    #     Returns:
    #         List of OAuthToken objects
    #     """
    #     client = await self._db.client
    #     result = await client.table('google_oauth_tokens').select('*')\
    #         .eq('user_id', user_id)\
    #         .order('created_at', desc=True)\
    #         .execute()
    #     
    #     return [self._map_to_oauth_token(data) for data in result.data]
    
    async def delete_token(
        self,
        user_id: str
    ) -> bool:
        """
        Delete Google OAuth token for a user.
        
        Args:
            user_id: User identifier
            
        Returns:
            True if token was found and deleted, False otherwise
        """
        logger.debug(f"Deleting Google OAuth token for user {user_id}")
        
        client = await self._db.client
        result = await client.table('google_oauth_tokens').delete()\
            .eq('user_id', user_id)\
            .execute()
        
        success = len(result.data) > 0
        if success:
            logger.debug(f"Deleted Google OAuth token for user {user_id}")
        else:
            logger.debug(f"No Google OAuth token found for user {user_id}")
        
        return success
    
    async def is_token_valid(
        self,
        user_id: str
    ) -> bool:
        """
        Check if user has a valid (active and not expired) Google OAuth token.
        
        Args:
            user_id: User identifier
            
        Returns:
            True if valid token exists, False otherwise
        """
        token = await self.get_token(user_id)
        if not token:
            return False
        
        # Check if token is expired
        if token.expires_at and token.expires_at <= datetime.now(timezone.utc):
            logger.debug(f"Google OAuth token for user {user_id} is expired")
            return False
        
        return True
    
    # UNUSED: update_token_usage - never called anywhere
    # async def update_token_usage(
    #     self,
    #     user_id: str
    # ) -> None:
    #     """
    #     Update the last used timestamp for a token.
    #     
    #     Args:
    #         user_id: User identifier
    #     """
    #     client = await self._db.client
    #     await client.table('google_oauth_tokens').update({
    #         'updated_at': datetime.now(timezone.utc).isoformat()
    #     }).eq('user_id', user_id)\
    #       .execute()
    
    def _map_to_oauth_token(self, data: Dict[str, Any]) -> OAuthToken:
        """
        Map database row to OAuthToken object with decryption.
        
        Args:
            data: Database row data
            
        Returns:
            OAuthToken object
        """
        try:
            encrypted_token = base64.b64decode(data['encrypted_token'])
            token_data = self._encryption.decrypt_config(encrypted_token, data['token_hash'])
        except Exception as e:
            logger.error(f"Failed to decrypt OAuth token {data['id']}: {e}")
            token_data = {}
        
        return OAuthToken(
            id=data['id'],
            user_id=data['user_id'],
            token_data=token_data,
            expires_at=datetime.fromisoformat(data['expires_at'].replace('Z', '+00:00')) if data.get('expires_at') else None,
            is_active=True,  # All tokens in DB are active (no soft delete)
            created_at=datetime.fromisoformat(data['created_at'].replace('Z', '+00:00')) if data.get('created_at') else None,
            updated_at=datetime.fromisoformat(data['updated_at'].replace('Z', '+00:00')) if data.get('updated_at') else None
        )


# ================== GOOGLE SLIDES SERVICE ==================

class GoogleSlidesService:
    """Service for Google Slides integration with OAuth and PPTX upload."""
    
    def __init__(self, oauth_token_service: OAuthTokenService):
        """Initialize the Google Slides service with OAuth configuration."""
        # OAuth configuration - these should be environment variables in production
        self.client_id = os.getenv("GOOGLE_CLIENT_ID")
        self.client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
        self.redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/api/google/callback")
        
        # Validate required credentials
        if not self.client_id or not self.client_secret:
            logger.warning("Google OAuth credentials not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET environment variables.")
            logger.warning("Google Slides integration will not work until credentials are properly configured.")
        
        # Required OAuth scopes
        self.scopes = [
            "https://www.googleapis.com/auth/drive.file"
        ]
        
        # Database token storage
        self.oauth_service = oauth_token_service
        
        logger.info("GoogleSlidesService initialized with database token storage")

    def get_auth_url(self, user_id: str, return_url: Optional[str] = None) -> str:
        """Generate Google OAuth authorization URL for a user."""
        # Generate state parameter for security, including return URL if provided
        if return_url:
            # Encode return URL in state: user_id:uuid:base64_encoded_return_url
            encoded_return_url = base64.urlsafe_b64encode(return_url.encode()).decode()
            state = f"{user_id}:{uuid.uuid4().hex}:{encoded_return_url}"
        else:
            state = f"{user_id}:{uuid.uuid4().hex}"
        
        auth_params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": " ".join(self.scopes),
            "state": state,
            "access_type": "offline",  # To get refresh token
            "prompt": "consent"  # Force consent to ensure refresh token
        }
        
        auth_url = f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(auth_params)}"
        logger.debug(f"Generated auth URL for user {user_id}")
        return auth_url

    async def handle_oauth_callback(self, code: str, state: str) -> tuple[Dict[str, Any], Optional[str]]:
        """Handle OAuth callback and exchange code for tokens."""
        try:
            # Extract user_id and return_url from state
            state_parts = state.split(':')
            user_id = state_parts[0]
            
            # Extract return URL if present (3rd part is base64 encoded return URL)
            return_url = None
            if len(state_parts) >= 3:
                try:
                    return_url = base64.urlsafe_b64decode(state_parts[2]).decode()
                except Exception as e:
                    logger.warning(f"Failed to decode return URL from state: {e}")
            
            logger.debug(f"Handling OAuth callback for user {user_id}, return_url: {return_url}")
            
            # Exchange authorization code for tokens
            token_data = {
                "grant_type": "authorization_code",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "redirect_uri": self.redirect_uri,
                "code": code
            }
            
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    "https://oauth2.googleapis.com/token",
                    data=token_data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"}
                )
            
            if response.status_code != 200:
                logger.error(f"Token exchange failed: {response.status_code} - {response.text}")
                raise HTTPException(status_code=400, detail="Failed to exchange authorization code")
            
            tokens = response.json()
            
            # Calculate expiry time  
            expires_in = tokens.get('expires_in', 3600)
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
            
            # Store tokens in database
            await self.oauth_service.store_token(
                user_id=user_id,
                token_data=tokens,
                expires_at=expires_at
            )
            
            logger.info(f"Successfully stored tokens for user {user_id}")
            return {
                "success": True,
                "message": "Authentication successful",
                "user_id": user_id
            }, return_url
            
        except Exception as e:
            logger.error(f"OAuth callback error: {e}")
            raise HTTPException(status_code=500, detail=f"OAuth callback failed: {str(e)}")

    async def is_user_authenticated(self, user_id: str) -> bool:
        """Check if user has valid authentication."""
        # First check if OAuth credentials are configured
        if await self.oauth_service.get_token(user_id):
            return True
        
        return False

    async def _refresh_token(self, user_id: str) -> bool:
        """Refresh an expired access token using the refresh token."""
        # Get current token from database
        oauth_token = await self.oauth_service.get_token(user_id)
        if not oauth_token:
            logger.warning(f"No tokens found for user {user_id}")
            return False
        
        refresh_token = oauth_token.token_data.get('refresh_token')
        if not refresh_token:
            logger.warning(f"No refresh token available for user {user_id}")
            return False
        
        try:
            refresh_data = {
                "grant_type": "refresh_token",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "refresh_token": refresh_token
            }
            
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    "https://oauth2.googleapis.com/token",
                    data=refresh_data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"}
                )
            
            if response.status_code != 200:
                logger.error(f"Token refresh failed: {response.status_code} - {response.text}")
                return False
            
            new_tokens = response.json()
            
            # Keep the refresh token if not provided in response
            if 'refresh_token' not in new_tokens:
                new_tokens['refresh_token'] = refresh_token
            
            # Calculate new expiry time
            expires_in = new_tokens.get('expires_in', 3600)
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
            
            # Store updated tokens in database
            await self.oauth_service.store_token(
                user_id=user_id,
                token_data=new_tokens,
                expires_at=expires_at
            )
            
            logger.info(f"Successfully refreshed token for user {user_id}")
            return True
            
        except Exception as e:
            logger.error(f"Token refresh error: {e}")
            return False

    async def get_valid_access_token(self, user_id: str) -> Optional[str]:
        """Get a valid access token for the user, refreshing if necessary."""
        # Get token from database
        oauth_token = await self.oauth_service.get_token(user_id)
        if not oauth_token:
            logger.warning(f"No tokens found for user {user_id}")
            return None
        
        # Check if token is expired and refresh if needed
        if oauth_token.expires_at and oauth_token.expires_at <= datetime.now(timezone.utc):
            logger.debug(f"Token expired for user {user_id}, attempting refresh")
            if not await self._refresh_token(user_id):
                return None
            # Get the refreshed token
            oauth_token = await self.oauth_service.get_token(user_id)
            if not oauth_token:
                return None
        
        return oauth_token.token_data.get('access_token')

    async def upload_pptx_to_slides(
        self, 
        pptx_file_path: Path, 
        user_id: str, 
        presentation_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Upload a PPTX file to Google Drive and convert it to Google Slides.
        
        Args:
            pptx_file_path: Path to the PPTX file to upload
            user_id: User identifier for authentication
            presentation_name: Optional custom name for the presentation
            
        Returns:
            Dict containing file_id, web_view_link, and other metadata
        """
        if not pptx_file_path.exists():
            raise HTTPException(status_code=404, detail=f"PPTX file not found: {pptx_file_path}")
        
        # Get valid token with auto-refresh (single database call)
        oauth_token = await self.oauth_service.get_token(user_id)
        if not oauth_token:
            raise HTTPException(status_code=401, detail="User not authenticated with Google")
        
        # Check if token is expired and refresh if needed
        if oauth_token.expires_at and oauth_token.expires_at <= datetime.now(timezone.utc):
            logger.debug(f"Token expired for user {user_id}, attempting refresh")
            if not await self._refresh_token(user_id):
                raise HTTPException(status_code=401, detail="Failed to refresh token")
            # Get the refreshed token
            oauth_token = await self.oauth_service.get_token(user_id)
            if not oauth_token:
                raise HTTPException(status_code=401, detail="No authentication token found after refresh")
        
        # Prepare file metadata
        file_name = presentation_name or pptx_file_path.stem
        metadata = {
            "name": file_name,
            "mimeType": "application/vnd.google-apps.presentation"  # This converts PPTX to Google Slides
        }
        
        try:
            credentials = Credentials(
                token=oauth_token.token_data.get("access_token"),
                refresh_token=oauth_token.token_data.get("refresh_token"),
                token_uri="https://oauth2.googleapis.com/token",
                client_id=self.client_id,
                client_secret=self.client_secret
            )
            
            # Build the Drive service
            service = build('drive', 'v3', credentials=credentials)
            
            media = MediaFileUpload(
                str(pptx_file_path),
                mimetype='application/vnd.openxmlformats-officedocument.presentationml.presentation'
            )
            
            logger.debug(f"Uploading PPTX file: {pptx_file_path}")
            logger.debug(f"Metadata: {json.dumps(metadata)}")
            
            # Create the file and convert to Google Slides
            file = service.files().create(
                body=metadata,
                media_body=media,
                fields='id,name,webViewLink,mimeType'
            ).execute()
            
            logger.info(f"Successfully uploaded and converted PPTX to Google Slides: {file.get('id')}")
            
            return {
                "file_id": file.get('id'),
                "name": file.get('name'),
                "web_view_link": file.get('webViewLink'),
                "mime_type": file.get('mimeType'),
                "message": "Successfully uploaded and converted to Google Slides"
            }
            
        except HttpError as error:
            logger.error(f"Google API error during upload: {error}")
            if error.resp.status == 401:
                # Token might be invalid, try to refresh
                if await self._refresh_token(user_id):
                    # Retry once with refreshed token
                    return await self.upload_pptx_to_slides(pptx_file_path, user_id, presentation_name)
                else:
                    raise HTTPException(status_code=401, detail="Authentication failed - please re-authenticate")
            else:
                raise HTTPException(status_code=500, detail=f"Google API error: {error}")
        except Exception as e:
            logger.error(f"Unexpected error during upload: {e}")
            raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

    # UNUSED: get_user_auth_status - never called anywhere  
    # async def get_user_auth_status(self, user_id: str) -> Dict[str, Any]:
    #     """Get authentication status for a user."""
    #     is_authenticated = await self.is_user_authenticated(user_id)
    #     oauth_token = await self.oauth_service.get_token(user_id)
    #     
    #     status = {
    #         "user_id": user_id,
    #         "is_authenticated": is_authenticated,
    #         "has_tokens": oauth_token is not None
    #     }
    #     
    #     if is_authenticated and oauth_token:
    #         if oauth_token.expires_at:
    #             status["token_expires_at"] = oauth_token.expires_at.isoformat()
    #     
    #     return status

    async def disconnect_user(self, user_id: str) -> Dict[str, Any]:
        """Disconnect user by removing their OAuth tokens."""
        success = await self.oauth_service.delete_token(user_id)
        
        if success:
            logger.info(f"Successfully disconnected user {user_id} from Google")
            return {"success": True, "message": "Successfully disconnected from Google"}
        else:
            return {"success": False, "message": "No authentication found to disconnect"}
