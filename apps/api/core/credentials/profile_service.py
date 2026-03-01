import uuid
import json
import hashlib
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional, Tuple

from cryptography.fernet import Fernet

# MIGRATED: from core.services.supabase import DBConnection
# Using Convex client for data operations
from core.services.convex_client import get_convex_client
from core.utils.logger import logger
from .credential_service import EncryptionService


@dataclass(frozen=True)
class MCPCredentialProfile:
    profile_id: str
    account_id: str
    mcp_qualified_name: str
    profile_name: str
    display_name: str
    config: Dict[str, Any]
    is_active: bool
    is_default: bool
    last_used_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass(frozen=True)
class CredentialMapping:
    qualified_name: str
    profile_id: str
    profile_name: str
    display_name: str


@dataclass
class ProfileRequest:
    account_id: str
    mcp_qualified_name: str
    profile_name: str
    display_name: str
    config: Dict[str, Any]
    is_default: bool = False


class ProfileNotFoundError(Exception):
    pass


class ProfileAccessDeniedError(Exception):
    pass


class ProfileService:
    """Service for managing MCP credential profiles.

    Uses Convex client for all data operations via HTTP endpoints:
    - POST /api/credential-profiles - Store profile
    - GET /api/credential-profiles - List profiles
    - GET /api/credential-profiles/get - Get profile by ID
    - PATCH /api/credential-profiles/set-default - Set default profile
    - DELETE /api/credential-profiles - Delete profile
    """
    
    def __init__(self, db_connection=None):
        # db_connection is kept for backward compatibility but not used
        # We now use the Convex client singleton
        self._convex = get_convex_client()
        self._encryption = EncryptionService()
    
    async def store_profile(
        self,
        account_id: str,
        mcp_qualified_name: str,
        profile_name: str,
        display_name: str,
        config: Dict[str, Any],
        is_default: bool = False
    ) -> str:
        logger.debug(f"Storing profile '{profile_name}' for {mcp_qualified_name}")
        
        profile_id = str(uuid.uuid4())
        encrypted_config, config_hash = self._encryption.encrypt_config(config)
        encoded_config = base64.b64encode(encrypted_config).decode('utf-8')
        
        # Store profile via Convex client
        await self._convex.store_credential_profile(
            profile_id=profile_id,
            account_id=account_id,
            mcp_qualified_name=mcp_qualified_name,
            profile_name=profile_name,
            display_name=display_name,
            encrypted_config=encoded_config,
            config_hash=config_hash,
            is_default=is_default,
            is_active=True
        )
        
        logger.debug(f"Stored profile {profile_id} '{profile_name}' for {mcp_qualified_name}")
        return profile_id
    
    async def get_profile(self, account_id: str, profile_id: str) -> Optional[MCPCredentialProfile]:
        # Get profile via Convex client
        try:
            result = await self._convex.get_credential_profile(profile_id, account_id)
            if not result:
                return None
            
            profile = self._map_to_profile(result)
            
            if profile.account_id != account_id:
                raise ProfileAccessDeniedError("Access denied to profile")
            
            return profile
        except ProfileAccessDeniedError:
            raise
        except Exception as e:
            logger.error(f"Error getting profile: {e}")
            return None
    
    async def get_profiles(
        self, 
        account_id: str, 
        mcp_qualified_name: str
    ) -> List[MCPCredentialProfile]:
        # Get profiles for MCP via Convex client
        try:
            rows = await self._convex.list_credential_profiles(
                account_id, 
                mcp_qualified_name=mcp_qualified_name
            )
            return [self._map_to_profile(data) for data in rows]
        except Exception as e:
            logger.error(f"Error getting profiles: {e}")
            return []
    
    async def get_all_user_profiles(self, account_id: str) -> List[MCPCredentialProfile]:
        # Get all user profiles via Convex client
        try:
            rows = await self._convex.list_credential_profiles(account_id)
            return [self._map_to_profile(data) for data in rows]
        except Exception as e:
            logger.error(f"Error listing profiles: {e}")
            return []
    
    async def get_default_profile(
        self, 
        account_id: str, 
        mcp_qualified_name: str
    ) -> Optional[MCPCredentialProfile]:
        # Get default profile via Convex client
        try:
            result = await self._convex.get_default_credential_profile(account_id, mcp_qualified_name)
            if result:
                return self._map_to_profile(result)
        except Exception:
            pass
        
        # Fall back to first available profile
        profiles = await self.find_profiles(account_id, mcp_qualified_name)
        return profiles[0] if profiles else None
    
    async def set_default_profile(self, account_id: str, profile_id: str) -> bool:
        logger.debug(f"Setting profile {profile_id} as default")
        
        # Set default profile via Convex client
        try:
            result = await self._convex.set_default_credential_profile(profile_id, account_id)
            success = result.get('success', False)
            if success:
                logger.debug(f"Set profile {profile_id} as default")
            return success
        except Exception as e:
            logger.error(f"Error setting default profile: {e}")
            return False
    
    async def delete_profile(self, account_id: str, profile_id: str) -> bool:
        logger.debug(f"Deleting profile {profile_id}")
        
        # Delete profile via Convex client
        try:
            result = await self._convex.delete_credential_profile(profile_id, account_id)
            success = result.get('success', False)
            if success:
                logger.debug(f"Deleted profile {profile_id}")
            return success
        except Exception as e:
            logger.error(f"Error deleting profile: {e}")
            return False
    
    async def find_profiles(
        self, 
        account_id: str, 
        mcp_qualified_name: str
    ) -> List[MCPCredentialProfile]:
        profiles = await self.get_profiles(account_id, mcp_qualified_name)
        
        if profiles:
            return profiles
        
        if mcp_qualified_name.startswith('custom_'):
            all_profiles = await self.get_all_user_profiles(account_id)
            matching_profiles = []
            
            for profile in all_profiles:
                if profile.mcp_qualified_name.startswith('custom_'):
                    profile_parts = profile.mcp_qualified_name.split('_')
                    search_parts = mcp_qualified_name.split('_')
                    
                    if len(profile_parts) >= 2 and len(search_parts) >= 2:
                        if profile_parts[1] == search_parts[1]:
                            matching_profiles.append(profile)
            
            return matching_profiles
        
        return []
    
    async def validate_profile_access(self, profile: MCPCredentialProfile, account_id: str) -> None:
        if profile.account_id != account_id:
            raise ProfileAccessDeniedError("Access denied to profile")
    
    def _map_to_profile(self, data: Dict[str, Any]) -> MCPCredentialProfile:
        try:
            encrypted_config = base64.b64decode(data['encrypted_config'])
            config = self._encryption.decrypt_config(encrypted_config, data.get('config_hash', ''))
        except Exception as e:
            logger.error(f"Failed to decrypt profile {data['profile_id']}: {e}")
            config = {}
        
        return MCPCredentialProfile(
            profile_id=data['profile_id'],
            account_id=data['account_id'],
            mcp_qualified_name=data['mcp_qualified_name'],
            profile_name=data['profile_name'],
            display_name=data['display_name'],
            config=config,
            is_active=data['is_active'],
            is_default=data.get('is_default', False),
            last_used_at=datetime.fromisoformat(data['last_used_at'].replace('Z', '+00:00')) if data.get('last_used_at') else None,
            created_at=datetime.fromisoformat(data['created_at'].replace('Z', '+00:00')) if data.get('created_at') else None,
            updated_at=datetime.fromisoformat(data['updated_at'].replace('Z', '+00:00')) if data.get('updated_at') else None
        )


def get_profile_service(db_connection=None) -> ProfileService:
    return ProfileService(db_connection)