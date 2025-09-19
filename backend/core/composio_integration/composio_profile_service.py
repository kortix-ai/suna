import json
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from uuid import uuid4
from cryptography.fernet import Fernet
import os

from core.services.supabase import DBConnection
from core.utils.logger import logger


@dataclass
class ComposioProfile:
    profile_id: str
    account_id: str
    mcp_qualified_name: str
    profile_name: str
    display_name: str
    encrypted_config: str
    config_hash: str
    toolkit_slug: str
    toolkit_name: str
    mcp_url: str
    redirect_url: Optional[str] = None
    connected_account_id: Optional[str] = None
    is_active: bool = True
    is_default: bool = False
    is_connected: bool = False
    created_at: datetime = None
    updated_at: datetime = None


class ComposioProfileService:
    def __init__(self, db_connection: Optional[DBConnection] = None):
        self.db = db_connection or DBConnection()
        
    def _get_encryption_key(self) -> bytes:
        key = os.getenv("ENCRYPTION_KEY")
        if not key:
            raise ValueError("ENCRYPTION_KEY environment variable is required")
        return key.encode()

    def _encrypt_config(self, config_json: str) -> str:
        fernet = Fernet(self._get_encryption_key())
        return fernet.encrypt(config_json.encode()).decode()

    def _decrypt_config(self, encrypted_config: str) -> Dict[str, Any]:
        fernet = Fernet(self._get_encryption_key())
        decrypted = fernet.decrypt(encrypted_config.encode()).decode()
        return json.loads(decrypted)

    def _generate_config_hash(self, config_json: str) -> str:
        return hashlib.sha256(config_json.encode()).hexdigest()

    def _build_config(
        self,
        toolkit_slug: str,
        toolkit_name: str,
        mcp_url: str,
        redirect_url: Optional[str] = None,
        user_id: str = "default",
        connected_account_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return {
            "type": "composio",
            "toolkit_slug": toolkit_slug,
            "toolkit_name": toolkit_name,
            "mcp_url": mcp_url,
            "redirect_url": redirect_url,
            "user_id": user_id,
            "connected_account_id": connected_account_id,
            "created_at": datetime.now(timezone.utc).isoformat()
        }

    async def _generate_unique_profile_name(self, base_name: str, account_id: str, mcp_qualified_name: str, client) -> str:
        original_name = base_name
        counter = 1
        current_name = base_name
        
        while True:
            existing = await client.table('user_mcp_credential_profiles').select('profile_id').eq(
                'account_id', account_id
            ).eq('mcp_qualified_name', mcp_qualified_name).eq('profile_name', current_name).execute()
            
            if not existing.data:
                return current_name
            
            counter += 1
            current_name = f"{original_name} ({counter})"

    async def create_profile(
        self,
        account_id: str,
        profile_name: str,
        toolkit_slug: str,
        toolkit_name: str,
        mcp_url: str,
        redirect_url: Optional[str] = None,
        user_id: str = "default",
        is_default: bool = False,
        connected_account_id: Optional[str] = None,
    ) -> ComposioProfile:
        try:
            logger.debug(f"Creating Composio profile for user: {account_id}, toolkit: {toolkit_slug}")
            logger.debug(f"MCP URL to store: {mcp_url}")
            
            config = self._build_config(
                toolkit_slug, toolkit_name, mcp_url, redirect_url, user_id, connected_account_id
            )
            config_json = json.dumps(config, sort_keys=True)
            encrypted_config = self._encrypt_config(config_json)
            config_hash = self._generate_config_hash(config_json)
            
            mcp_qualified_name = f"composio.{toolkit_slug}"
            profile_id = str(uuid4())
            now = datetime.now(timezone.utc)
            
            client = await self.db.client
            
            unique_profile_name = await self._generate_unique_profile_name(
                profile_name, account_id, mcp_qualified_name, client
            )
            
            if unique_profile_name != profile_name:
                logger.debug(f"Generated unique profile name: {unique_profile_name} (original: {profile_name})")
            
            if is_default:
                await client.table('user_mcp_credential_profiles').update({
                    'is_default': False
                }).eq('account_id', account_id).eq('mcp_qualified_name', mcp_qualified_name).execute()
            
            result = await client.table('user_mcp_credential_profiles').insert({
                'profile_id': profile_id,
                'account_id': account_id,
                'mcp_qualified_name': mcp_qualified_name,
                'profile_name': unique_profile_name,
                'display_name': unique_profile_name,
                'encrypted_config': encrypted_config,
                'config_hash': config_hash,
                'is_active': True,
                'is_default': is_default,
                'created_at': now.isoformat(),
                'updated_at': now.isoformat()
            }).execute()
            
            if not result.data:
                raise Exception("Failed to create profile in database")
            
            logger.debug(f"Successfully created Composio profile: {profile_id}")
            
            return ComposioProfile(
                profile_id=profile_id,
                account_id=account_id,
                mcp_qualified_name=mcp_qualified_name,
                profile_name=unique_profile_name,
                display_name=unique_profile_name,
                encrypted_config=encrypted_config,
                config_hash=config_hash,
                toolkit_slug=toolkit_slug,
                toolkit_name=toolkit_name,
                mcp_url=mcp_url,
                redirect_url=redirect_url,
                connected_account_id=connected_account_id,
                is_active=True,
                is_default=is_default,
                is_connected=bool(redirect_url),
                created_at=now,
                updated_at=now
            )
            
        except Exception as e:
            logger.error(f"Failed to create Composio profile: {e}", exc_info=True)
            raise

    async def get_mcp_config_for_agent(self, profile_id: str) -> Dict[str, Any]:
        try:
            client = await self.db.client
            result = await client.table('user_mcp_credential_profiles').select('*').eq(
                'profile_id', profile_id
            ).execute()
            
            if not result.data:
                raise ValueError(f"Profile {profile_id} not found")
            
            profile_data = result.data[0]

            config = self._decrypt_config(profile_data['encrypted_config'])
            
            if config.get('type') != 'composio':
                raise ValueError(f"Profile {profile_id} is not a Composio profile")
            
            return {
                "name": config['toolkit_name'],
                "type": "composio",
                "mcp_qualified_name": profile_data['mcp_qualified_name'],
                "toolkit_slug": config.get('toolkit_slug', ''),
                "config": {
                    "profile_id": profile_id
                },
                "enabledTools": []
            }
            
        except Exception as e:
            logger.error(f"Failed to get MCP config for profile {profile_id}: {e}", exc_info=True)
            raise
    
    async def get_mcp_url_for_runtime(self, profile_id: str) -> str:
        try:
            client = await self.db.client
            
            result = await client.table('user_mcp_credential_profiles').select('*').eq(
                'profile_id', profile_id
            ).execute()
            
            if not result.data:
                raise ValueError(f"Profile {profile_id} not found")
            
            profile_data = result.data[0]
            
            config = self._decrypt_config(profile_data['encrypted_config'])
            
            if config.get('type') != 'composio':
                raise ValueError(f"Profile {profile_id} is not a Composio profile")
            
            mcp_url = config.get('mcp_url')
            if not mcp_url:
                raise ValueError(f"Profile {profile_id} has no MCP URL")
            
            logger.debug(f"Retrieved MCP URL for profile {profile_id}")
            return mcp_url
            
        except Exception as e:
            logger.error(f"Failed to get MCP URL for profile {profile_id}: {e}", exc_info=True)
            raise

    async def get_profile_config(self, profile_id: str) -> Dict[str, Any]:
        try:
            client = await self.db.client
            
            result = await client.table('user_mcp_credential_profiles').select('encrypted_config').eq(
                'profile_id', profile_id
            ).execute()
            
            if not result.data:
                raise ValueError(f"Profile {profile_id} not found")
            
            return self._decrypt_config(result.data[0]['encrypted_config'])
            
        except Exception as e:
            logger.error(f"Failed to get config for profile {profile_id}: {e}", exc_info=True)
            raise

    async def get_profiles(self, account_id: str, toolkit_slug: Optional[str] = None) -> List[ComposioProfile]:
        try:
            client = await self.db.client
            
            query = client.table('user_mcp_credential_profiles').select('*').eq('account_id', account_id)
            
            if toolkit_slug:
                query = query.eq('mcp_qualified_name', f"composio.{toolkit_slug}")
            else:
                query = query.like('mcp_qualified_name', 'composio.%')
            
            result = await query.execute()
            
            profiles = []
            for row in result.data:
                config = self._decrypt_config(row['encrypted_config'])
                
                profile = ComposioProfile(
                    profile_id=row['profile_id'],
                    account_id=row['account_id'],
                    mcp_qualified_name=row['mcp_qualified_name'],
                    profile_name=row['profile_name'],
                    display_name=row['display_name'],
                    encrypted_config=row['encrypted_config'],
                    config_hash=row['config_hash'],
                    toolkit_slug=config.get('toolkit_slug', ''),
                    toolkit_name=config.get('toolkit_name', ''),
                    mcp_url=config.get('mcp_url', ''),
                    redirect_url=config.get('redirect_url'),
                    connected_account_id=config.get('connected_account_id'),
                    is_active=row.get('is_active', True),
                    is_default=row.get('is_default', False),
                    is_connected=bool(config.get('redirect_url')),
                    created_at=datetime.fromisoformat(row['created_at'].replace('Z', '+00:00')) if row.get('created_at') else None,
                    updated_at=datetime.fromisoformat(row['updated_at'].replace('Z', '+00:00')) if row.get('updated_at') else None
                )
                profiles.append(profile)
            
            return profiles
            
        except Exception as e:
            logger.error(f"Failed to get Composio profiles: {e}", exc_info=True)
            raise 