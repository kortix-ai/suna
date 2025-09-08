import json
import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from uuid import uuid4, UUID

from core.services.supabase import DBConnection
from core.utils.logger import logger


@dataclass
class Profile:
    profile_id: str
    account_id: str
    mcp_qualified_name: str
    profile_name: str
    display_name: str
    encrypted_config: str
    config_hash: str
    app_slug: str
    app_name: str
    external_user_id: str
    enabled_tools: List[str] = field(default_factory=list)
    is_active: bool = True
    is_default: bool = False
    is_connected: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_used_at: Optional[datetime] = None
    description: Optional[str] = None
    oauth_app_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            'profile_id': self.profile_id,
            'account_id': self.account_id,
            'mcp_qualified_name': self.mcp_qualified_name,
            'profile_name': self.profile_name,
            'display_name': self.display_name,
            'encrypted_config': self.encrypted_config,
            'config_hash': self.config_hash,
            'app_slug': self.app_slug,
            'app_name': self.app_name,
            'external_user_id': self.external_user_id,
            'enabled_tools': self.enabled_tools,
            'is_active': self.is_active,
            'is_default': self.is_default,
            'is_connected': self.is_connected,
            'created_at': self.created_at.isoformat(),
            'updated_at': self.updated_at.isoformat(),
            'last_used_at': self.last_used_at.isoformat() if self.last_used_at else None,
            'description': self.description,
            'oauth_app_id': self.oauth_app_id
        }


class ProfileServiceError(Exception):
    pass

class ProfileNotFoundError(ProfileServiceError):
    pass

class ProfileAlreadyExistsError(ProfileServiceError):
    pass

class InvalidConfigError(ProfileServiceError):
    pass

class EncryptionError(ProfileServiceError):
    pass


class ProfileService:
    def __init__(self):
        self.db = DBConnection()
        self._connection_service = None
    
    async def _get_client(self):
        return await self.db.client
    
    def _get_connection_service(self):
        if self._connection_service is None:
            from .connection_service import ConnectionService
            from core.utils.logger import logger
            self._connection_service = ConnectionService(logger=logger)
        return self._connection_service
    
    async def _check_connection_status(self, external_user_id: str, app_slug: str) -> bool:
        try:
            from .connection_service import ExternalUserId, AppSlug
            connection_service = self._get_connection_service()
            return await connection_service.has_connection(
                ExternalUserId(external_user_id), 
                AppSlug(app_slug)
            )
        except Exception as e:
            logger.error(f"Error checking connection status: {str(e)}")
            return False
    
    def _validate_app_slug(self, app_slug: str) -> None:
        if not app_slug or not isinstance(app_slug, str):
            raise InvalidConfigError("App slug must be a non-empty string")
        if not re.match(r'^[a-z0-9_-]+$', app_slug):
            raise InvalidConfigError("App slug must contain only lowercase letters, numbers, hyphens, and underscores")
    
    def _validate_profile_name(self, profile_name: str) -> None:
        if not profile_name or not isinstance(profile_name, str):
            raise InvalidConfigError("Profile name must be a non-empty string")
        if len(profile_name) > 100:
            raise InvalidConfigError("Profile name must be less than 100 characters")
    
    def _generate_external_user_id(self, account_id: str, app_slug: str, profile_name: str) -> str:
        combined = f"{account_id}:{app_slug}:{profile_name}"
        hash_value = hashlib.sha256(combined.encode()).hexdigest()[:16]
        return f"suna_{hash_value}"
    
    def _generate_config_hash(self, config_json: str) -> str:
        return hashlib.sha256(config_json.encode()).hexdigest()
    
    def _encrypt_config(self, config_json: str) -> str:
        try:
            from core.utils.encryption import encrypt_data
            return encrypt_data(config_json)
        except Exception as e:
            raise EncryptionError(f"Failed to encrypt config: {str(e)}")
    
    def _decrypt_config(self, encrypted_config: str) -> Dict[str, Any]:
        try:
            from core.utils.encryption import decrypt_data
            decrypted_json = decrypt_data(encrypted_config)
            return json.loads(decrypted_json)
        except Exception as e:
            raise EncryptionError(f"Failed to decrypt config: {str(e)}")
    
    def _build_config(self, app_slug: str, app_name: str, external_user_id: str, 
                     enabled_tools: List[str], oauth_app_id: Optional[str] = None,
                     description: Optional[str] = None) -> Dict[str, Any]:
        return {
            "app_slug": app_slug,
            "app_name": app_name,
            "external_user_id": external_user_id,
            "enabled_tools": enabled_tools,
            "oauth_app_id": oauth_app_id,
            "description": description
        }
    
    async def _map_row_to_profile(self, row: Dict[str, Any]) -> Profile:
        try:
            config = self._decrypt_config(row['encrypted_config'])
        except Exception:
            config = {
                "app_slug": "unknown",
                "app_name": "Unknown App",
                "external_user_id": "unknown",
                "enabled_tools": [],
                "oauth_app_id": None,
                "description": None
            }
        
        is_connected = await self._check_connection_status(config['external_user_id'], config['app_slug'])
        
        return Profile(
            profile_id=row['profile_id'],
            account_id=row['account_id'],
            mcp_qualified_name=row['mcp_qualified_name'],
            profile_name=row['profile_name'],
            display_name=row['display_name'],
            encrypted_config=row['encrypted_config'],
            config_hash=row['config_hash'],
            app_slug=config['app_slug'],
            app_name=config['app_name'],
            external_user_id=config['external_user_id'],
            enabled_tools=config.get('enabled_tools', []),
            is_active=row['is_active'],
            is_default=row['is_default'],
            is_connected=is_connected,
            created_at=datetime.fromisoformat(row['created_at'].replace('Z', '+00:00')) if isinstance(row['created_at'], str) else row['created_at'],
            updated_at=datetime.fromisoformat(row['updated_at'].replace('Z', '+00:00')) if isinstance(row['updated_at'], str) else row['updated_at'],
            last_used_at=datetime.fromisoformat(row['last_used_at'].replace('Z', '+00:00')) if row.get('last_used_at') and isinstance(row['last_used_at'], str) else row.get('last_used_at'),
            description=config.get('description'),
            oauth_app_id=config.get('oauth_app_id')
        )
    
    async def create_profile(
        self,
        account_id: str,
        profile_name: str,
        app_slug: str,
        app_name: str,
        description: Optional[str] = None,
        is_default: bool = False,
        oauth_app_id: Optional[str] = None,
        enabled_tools: Optional[List[str]] = None,
        external_user_id: Optional[str] = None
    ) -> Profile:
        self._validate_app_slug(app_slug)
        self._validate_profile_name(profile_name)
        
        if enabled_tools is None:
            enabled_tools = []
        
        if not external_user_id:
            external_user_id = self._generate_external_user_id(account_id, app_slug, profile_name)
        
        config = self._build_config(app_slug, app_name, external_user_id, enabled_tools, oauth_app_id, description)
        config_json = json.dumps(config, sort_keys=True)
        encrypted_config = self._encrypt_config(config_json)
        config_hash = self._generate_config_hash(config_json)
        
        mcp_qualified_name = f"pipedream:{app_slug}"
        profile_id = str(uuid4())
        now = datetime.now(timezone.utc)
        
        client = await self._get_client()
        
        try:
            existing = await client.table('user_mcp_credential_profiles').select('profile_id').eq(
                'account_id', account_id
            ).eq('mcp_qualified_name', mcp_qualified_name).eq('profile_name', profile_name).execute()
            
            if existing.data:
                raise ProfileAlreadyExistsError(f"Profile '{profile_name}' already exists for app '{app_slug}'")
            
            if is_default:
                await client.table('user_mcp_credential_profiles').update({
                    'is_default': False
                }).eq('account_id', account_id).eq('mcp_qualified_name', mcp_qualified_name).execute()
            
            result = await client.table('user_mcp_credential_profiles').insert({
                'profile_id': profile_id,
                'account_id': account_id,
                'mcp_qualified_name': mcp_qualified_name,
                'profile_name': profile_name,
                'display_name': profile_name,
                'encrypted_config': encrypted_config,
                'config_hash': config_hash,
                'is_active': True,
                'is_default': is_default,
                'created_at': now.isoformat(),
                'updated_at': now.isoformat()
            }).execute()
            
            if not result.data:
                raise ProfileServiceError("Failed to create profile")
            
            logger.debug(f"Created profile {profile_id} for app {app_slug}")
            
            return Profile(
                profile_id=profile_id,
                account_id=account_id,
                mcp_qualified_name=mcp_qualified_name,
                profile_name=profile_name,
                display_name=profile_name,
                encrypted_config=encrypted_config,
                config_hash=config_hash,
                app_slug=app_slug,
                app_name=app_name,
                external_user_id=external_user_id,
                enabled_tools=enabled_tools,
                is_active=True,
                is_default=is_default,
                is_connected=False,
                created_at=now,
                updated_at=now,
                description=description,
                oauth_app_id=oauth_app_id
            )
            
        except Exception as e:
            if isinstance(e, (ProfileAlreadyExistsError, ProfileServiceError)):
                raise
            logger.error(f"Error creating profile: {str(e)}")
            raise ProfileServiceError(f"Failed to create profile: {str(e)}")
    
    async def get_profile(self, account_id: str, profile_id: str) -> Optional[Profile]:
        client = await self._get_client()
        
        try:
            result = await client.table('user_mcp_credential_profiles').select('*').eq(
                'account_id', account_id
            ).eq('profile_id', profile_id).execute()
            
            if not result.data:
                return None
            
            return await self._map_row_to_profile(result.data[0])
            
        except Exception as e:
            logger.error(f"Error getting profile {profile_id}: {str(e)}")
            raise ProfileServiceError(f"Failed to get profile: {str(e)}")
    
    async def get_profiles(
        self,
        account_id: str,
        app_slug: Optional[str] = None,
        is_active: Optional[bool] = None
    ) -> List[Profile]:
        client = await self._get_client()
        
        try:
            query = client.table('user_mcp_credential_profiles').select('*').eq('account_id', account_id)
            
            if app_slug:
                mcp_qualified_name = f"pipedream:{app_slug}"
                query = query.eq('mcp_qualified_name', mcp_qualified_name)
            
            if is_active is not None:
                query = query.eq('is_active', is_active)
            
            result = await query.execute()
            
            import asyncio
            profiles = await asyncio.gather(*[self._map_row_to_profile(row) for row in result.data])
            return profiles
            
        except Exception as e:
            logger.error(f"Error getting profiles: {str(e)}")
            raise ProfileServiceError(f"Failed to get profiles: {str(e)}")
    
    async def update_profile(
        self,
        account_id: str,
        profile_id: str,
        profile_name: Optional[str] = None,
        display_name: Optional[str] = None,
        is_active: Optional[bool] = None,
        is_default: Optional[bool] = None,
        enabled_tools: Optional[List[str]] = None
    ) -> Profile:
        existing_profile = await self.get_profile(account_id, profile_id)
        if not existing_profile:
            raise ProfileNotFoundError(f"Profile {profile_id} not found")
        
        client = await self._get_client()
        updates = {'updated_at': datetime.now(timezone.utc).isoformat()}
        
        try:
            if enabled_tools is not None:
                config = self._decrypt_config(existing_profile.encrypted_config)
                config['enabled_tools'] = enabled_tools
                config_json = json.dumps(config, sort_keys=True)
                updates['encrypted_config'] = self._encrypt_config(config_json)
                updates['config_hash'] = self._generate_config_hash(config_json)
            
            if profile_name is not None:
                self._validate_profile_name(profile_name)
                updates['profile_name'] = profile_name
            
            if display_name is not None:
                updates['display_name'] = display_name
            
            if is_active is not None:
                updates['is_active'] = is_active
            
            if is_default is not None:
                if is_default:
                    await client.table('user_mcp_credential_profiles').update({
                        'is_default': False
                    }).eq('account_id', account_id).eq('mcp_qualified_name', existing_profile.mcp_qualified_name).execute()
                
                updates['is_default'] = is_default
            
            result = await client.table('user_mcp_credential_profiles').update(updates).eq(
                'profile_id', profile_id
            ).eq('account_id', account_id).execute()
            
            if not result.data:
                raise ProfileServiceError("Failed to update profile")
            
            logger.debug(f"Updated profile {profile_id}")
            
            return await self.get_profile(account_id, profile_id)
            
        except Exception as e:
            if isinstance(e, (ProfileNotFoundError, ProfileServiceError, InvalidConfigError)):
                raise
            logger.error(f"Error updating profile {profile_id}: {str(e)}")
            raise ProfileServiceError(f"Failed to update profile: {str(e)}")
    
    async def delete_profile(self, account_id: str, profile_id: str) -> bool:
        client = await self._get_client()
        
        try:
            result = await client.table('user_mcp_credential_profiles').delete().eq(
                'profile_id', profile_id
            ).eq('account_id', account_id).execute()
            
            success = bool(result.data)
            if success:
                logger.debug(f"Deleted profile {profile_id}")
            
            return success
            
        except Exception as e:
            logger.error(f"Error deleting profile {profile_id}: {str(e)}")
            raise ProfileServiceError(f"Failed to delete profile: {str(e)}")
    
    async def get_profile_by_app(
        self,
        account_id: str,
        app_slug: str,
        profile_name: Optional[str] = None
    ) -> Optional[Profile]:
        self._validate_app_slug(app_slug)
        
        client = await self._get_client()
        
        try:
            mcp_qualified_name = f"pipedream:{app_slug}"
            query = client.table('user_mcp_credential_profiles').select('*').eq(
                'account_id', account_id
            ).eq('mcp_qualified_name', mcp_qualified_name)
            
            if profile_name:
                self._validate_profile_name(profile_name)
                query = query.eq('profile_name', profile_name)
            else:
                query = query.eq('is_default', True)
            
            result = await query.execute()
            
            if not result.data:
                return None
            
            return await self._map_row_to_profile(result.data[0])
            
        except Exception as e:
            logger.error(f"Error getting profile by app {app_slug}: {str(e)}")
            raise ProfileServiceError(f"Failed to get profile by app: {str(e)}")


_profile_service = None

def get_profile_service() -> ProfileService:
    global _profile_service
    if _profile_service is None:
        _profile_service = ProfileService()
    return _profile_service 