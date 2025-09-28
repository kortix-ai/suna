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

from core.utils.logger import logger

from .google_slides_service import OAuthTokenService


class GoogleDocsService:
    def __init__(self, oauth_token_service: OAuthTokenService):
        self.client_id = os.getenv("GOOGLE_CLIENT_ID")
        self.client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
        self.redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/api/google/callback")
        
        if not self.client_id or not self.client_secret:
            logger.warning("Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.")
            logger.warning("Google Docs integration will not work until credentials are properly configured.")
        
        self.scopes = [
            "https://www.googleapis.com/auth/drive.file"
        ]
        
        self.oauth_service = oauth_token_service
        
        logger.info("GoogleDocsService initialized with database token storage")

    def get_auth_url(self, user_id: str, return_url: Optional[str] = None) -> str:
        if return_url:
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
            "access_type": "offline", 
            "prompt": "consent" 
        }
        
        auth_url = f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(auth_params)}"
        logger.debug(f"Generated auth URL for user {user_id}")
        return auth_url

    async def handle_oauth_callback(self, code: str, state: str) -> tuple[Dict[str, Any], Optional[str]]:
        try:
           
            state_parts = state.split(':')
            user_id = state_parts[0]
            
            
            return_url = None
            if len(state_parts) >= 3:
                try:
                    return_url = base64.urlsafe_b64decode(state_parts[2]).decode()
                except Exception as e:
                    logger.warning(f"Failed to decode return URL from state: {e}")
            
            logger.debug(f"Handling OAuth callback for user {user_id}, return_url: {return_url}")
            
           
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
            
           
            expires_in = tokens.get('expires_in', 3600)
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
            
           
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
        if await self.oauth_service.get_token(user_id):
            return True
        
        return False

    async def _refresh_token(self, user_id: str) -> bool:
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
            
            
            if 'refresh_token' not in new_tokens:
                new_tokens['refresh_token'] = refresh_token
            
            
            expires_in = new_tokens.get('expires_in', 3600)
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
            
            
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

    async def upload_docx_to_docs(
        self, 
        docx_file_path: Path, 
        user_id: str, 
        document_name: Optional[str] = None
    ) -> Dict[str, Any]:
        if not docx_file_path.exists():
            raise HTTPException(status_code=404, detail=f"DOCX file not found: {docx_file_path}")
        
        
        oauth_token = await self.oauth_service.get_token(user_id)
        if not oauth_token:
            raise HTTPException(status_code=401, detail="User not authenticated with Google")
        
       
        if oauth_token.expires_at and oauth_token.expires_at <= datetime.now(timezone.utc):
            logger.debug(f"Token expired for user {user_id}, attempting refresh")
            if not await self._refresh_token(user_id):
                raise HTTPException(status_code=401, detail="Failed to refresh token")
           
            oauth_token = await self.oauth_service.get_token(user_id)
            if not oauth_token:
                raise HTTPException(status_code=401, detail="No authentication token found after refresh")
        
       
        file_name = document_name or docx_file_path.stem
        metadata = {
            "name": file_name,
            "mimeType": "application/vnd.google-apps.document"  
        }
        
        try:
            credentials = Credentials(
                token=oauth_token.token_data.get("access_token"),
                refresh_token=oauth_token.token_data.get("refresh_token"),
                token_uri="https://oauth2.googleapis.com/token",
                client_id=self.client_id,
                client_secret=self.client_secret
            )
            
            
            service = build('drive', 'v3', credentials=credentials)
            
            media = MediaFileUpload(
                str(docx_file_path),
                mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            )
            
            logger.debug(f"Uploading DOCX file: {docx_file_path}")
            logger.debug(f"Metadata: {json.dumps(metadata)}")
            
            
            file = service.files().create(
                body=metadata,
                media_body=media,
                fields='id,name,webViewLink,mimeType'
            ).execute()
            
            logger.info(f"Successfully uploaded and converted DOCX to Google Docs: {file.get('id')}")
            
            return {
                "file_id": file.get('id'),
                "name": file.get('name'),
                "web_view_link": file.get('webViewLink'),
                "mime_type": file.get('mimeType'),
                "message": "Successfully uploaded and converted to Google Docs"
            }
            
        except HttpError as error:
            logger.error(f"Google API error during upload: {error}")
            if error.resp.status == 401:
                if await self._refresh_token(user_id):
                    return await self.upload_docx_to_docs(docx_file_path, user_id, document_name)
                else:
                    raise HTTPException(status_code=401, detail="Authentication failed - please re-authenticate")
            else:
                raise HTTPException(status_code=500, detail=f"Google API error: {error}")
        except Exception as e:
            logger.error(f"Unexpected error during upload: {e}")
            raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

    async def disconnect_user(self, user_id: str) -> Dict[str, Any]:
        success = await self.oauth_service.delete_token(user_id)
        
        if success:
            logger.info(f"Successfully disconnected user {user_id} from Google")
            return {"success": True, "message": "Successfully disconnected from Google"}
        else:
            return {"success": False, "message": "No authentication found to disconnect"}
