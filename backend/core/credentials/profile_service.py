import uuid
import json
import hashlib
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional, Tuple

from cryptography.fernet import Fernet

from core.services.supabase import DBConnection
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
    def __init__(self, db_connection: DBConnection):
        self._db = db_connection
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
        
        client = await self._db.client
        
        if is_default:
            await client.table('user_mcp_credential_profiles').update({
                'is_default': False,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).eq('account_id', account_id)\
              .eq('mcp_qualified_name', mcp_qualified_name)\
              .execute()
        
        result = await client.table('user_mcp_credential_profiles').insert({
            'profile_id': profile_id,
            'account_id': account_id,
            'mcp_qualified_name': mcp_qualified_name,
            'profile_name': profile_name,
            'display_name': display_name,
            'encrypted_config': encoded_config,
            'config_hash': config_hash,
            'is_active': True,
            'is_default': is_default,
            'created_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).execute()
        
        logger.debug(f"Stored profile {profile_id} '{profile_name}' for {mcp_qualified_name}")
        return profile_id
    
    async def get_profile(self, account_id: str, profile_id: str) -> Optional[MCPCredentialProfile]:
        client = await self._db.client
        result = await client.table('user_mcp_credential_profiles').select('*')\
            .eq('profile_id', profile_id)\
            .execute()
        
        if not result.data:
            return None
        
        profile = self._map_to_profile(result.data[0])
        
        if profile.account_id != account_id:
            raise ProfileAccessDeniedError("Access denied to profile")
        
        return profile
    
    async def get_profiles(
        self, 
        account_id: str, 
        mcp_qualified_name: str
    ) -> List[MCPCredentialProfile]:
        client = await self._db.client
        result = await client.table('user_mcp_credential_profiles').select('*')\
            .eq('account_id', account_id)\
            .eq('mcp_qualified_name', mcp_qualified_name)\
            .order('is_default', desc=True)\
            .order('created_at', desc=True)\
            .execute()
        
        return [self._map_to_profile(data) for data in result.data]
    
    async def get_all_user_profiles(self, account_id: str) -> List[MCPCredentialProfile]:
        client = await self._db.client
        result = await client.table('user_mcp_credential_profiles').select('*')\
            .eq('account_id', account_id)\
            .order('created_at', desc=True)\
            .execute()
        
        return [self._map_to_profile(data) for data in result.data]
    
    async def get_default_profile(
        self, 
        account_id: str, 
        mcp_qualified_name: str
    ) -> Optional[MCPCredentialProfile]:
        profiles = await self.find_profiles(account_id, mcp_qualified_name)
        
        for profile in profiles:
            if profile.is_default:
                return profile
        
        return profiles[0] if profiles else None
    
    async def set_default_profile(self, account_id: str, profile_id: str) -> bool:
        logger.debug(f"Setting profile {profile_id} as default")
        
        profile = await self.get_profile(account_id, profile_id)
        if not profile:
            return False
        
        client = await self._db.client
        
        await client.table('user_mcp_credential_profiles').update({
            'is_default': False,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', account_id)\
          .eq('mcp_qualified_name', profile.mcp_qualified_name)\
          .execute()
        
        result = await client.table('user_mcp_credential_profiles').update({
            'is_default': True,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('profile_id', profile_id)\
          .eq('account_id', account_id)\
          .execute()
        
        success = len(result.data) > 0
        if success:
            logger.debug(f"Set profile {profile_id} as default")
        
        return success 
    
    async def delete_profile(self, account_id: str, profile_id: str) -> bool:
        logger.debug(f"Deleting profile {profile_id}")
        
        client = await self._db.client
        result = await client.table('user_mcp_credential_profiles').delete()\
          .eq('profile_id', profile_id)\
          .eq('account_id', account_id)\
          .execute()
        
        success = len(result.data) > 0
        if success:
            logger.debug(f"Deleted profile {profile_id}")
        
        return success
    
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
            config = self._encryption.decrypt_config(encrypted_config, data['config_hash'])
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


def get_profile_service(db_connection: DBConnection) -> ProfileService:
    return ProfileService(db_connection) 