import json
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from uuid import uuid4
from cryptography.fernet import Fernet, InvalidToken
import os

from core.services.convex_client import get_convex_client
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
    def __init__(self, db_connection):
        # Keep db_connection for now as profile_service still uses it
        # TODO: Full migration when ProfileService is migrated to Convex
        self._db = db_connection
        from core.credentials.profile_service import ProfileService
        self.profile_service = ProfileService(db_connection)
        
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

    async def _generate_unique_profile_name(self, base_name: str, account_id: str, mcp_qualified_name: str) -> str:
        """Generate a unique profile name for Composio profiles.

        MIGRATED: Uses Convex client for profile name uniqueness check.
        """
        original_name = base_name
        counter = 1
        current_name = base_name

        while True:
            # MIGRATED: Using Convex client for profile name uniqueness check
            convex = get_convex_client()
            existing = await convex.get_composio_profiles(account_id=account_id, toolkit_slug=mcp_qualified_name.split('.')[0] if '.' in mcp_qualified_name else mcp_qualified_name)
            
            # Check if profile name exists
            if existing:
                matching_names = [p for p in existing if p.get('profile_name') == current_name]
                if not matching_names:
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
            
            # MIGRATED: Using Convex client for profile uniqueness check
            convex = get_convex_client()
            unique_profile_name = profile_name
            
            # Check if profile name is unique using Composio profiles list
            existing = await convex.get_composio_profiles(account_id=account_id, toolkit_slug=toolkit_slug)
            if existing:
                matching_names = [p for p in existing if p.get('profile_name') == unique_profile_name]
                if matching_names:
                    # Generate unique name if collision exists
                    unique_profile_name = await self._generate_unique_profile_name(
                        profile_name, account_id, mcp_qualified_name
                    )
            
            if unique_profile_name != profile_name:
                logger.debug(f"Generated unique profile name: {unique_profile_name} (original: {profile_name})")
            
            # MIGRATED: Use ProfileService to store the profile (which uses Convex)
            # The profile config contains all Composio-specific data
            await self.profile_service.store_profile(
                account_id=account_id,
                mcp_qualified_name=mcp_qualified_name,
                profile_name=unique_profile_name,
                display_name=unique_profile_name,
                config=config,
                is_default=is_default
            )
            
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

    async def get_mcp_config_for_agent(self, profile_id: str, account_id: str) -> Dict[str, Any]:
        """Get MCP config for agent execution.

        MIGRATED: Uses ProfileService which has been migrated to Convex.
        """
        try:
            # MIGRATED: Use ProfileService to get the profile
            profile = await self.profile_service.get_profile(account_id, profile_id)
            
            if not profile:
                raise ValueError(f"Profile {profile_id} not found")
            
            # Verify it's a Composio profile
            if not profile.mcp_qualified_name.startswith('composio.'):
                raise ValueError(f"Profile {profile_id} is not a Composio profile")
            
            toolkit_slug = profile.config.get('toolkit_slug', '')
            
            return {
                "name": profile.config.get('toolkit_name', 'Composio'),
                "type": "composio",
                "mcp_qualified_name": profile.mcp_qualified_name,
                "toolkit_slug": toolkit_slug,
                "config": {
                    "profile_id": profile_id
                },
                "enabledTools": []
            }
            
        except Exception as e:
            logger.error(f"Failed to get MCP config for profile {profile_id}: {e}", exc_info=True)
            raise
    
    async def get_mcp_url_for_runtime(self, profile_id: str, account_id: str) -> str:
        """Generate MCP URL for a Composio profile.
        
        MIGRATED: Uses ProfileService for profile lookup.
        """
        config = await self.get_profile_config(profile_id, account_id)
        
        toolkit_slug = config.get('toolkit_slug')
        user_id = config.get('connected_account_id')
        
        if not toolkit_slug or not user_id:
            raise ValueError("Profile missing required Composio fields")
        
        api_key = self.composio_client.api_key
        base_url = "https://mcp.composio.dev"
        mcp_url = f"{base_url}/{api_key}?userId={user_id}&toolkit={toolkit_slug}"
        
        return mcp_url

    async def get_profile_config(self, profile_id: str, account_id: str) -> Dict[str, Any]:
        """Get decrypted config for a profile.
        
        MIGRATED: Uses ProfileService which has been migrated to Convex.
        """
        profile = await self.profile_service.get_profile(account_id, profile_id)
        if not profile:
            raise ValueError(f"Profile {profile_id} not found")
        
        return profile.config

    async def get_profiles(self, account_id: str, toolkit_slug: Optional[str] = None) -> List[ComposioProfile]:
        """Get all Composio profiles for an account.

        MIGRATED: Uses Convex client's get_composio_profiles for data access.
        """
        try:
            # MIGRATED: Use Convex client's Composio-specific endpoint
            convex = get_convex_client()
            profiles_data = await convex.get_composio_profiles(
                account_id=account_id,
                toolkit_slug=toolkit_slug
            )
            
            profiles = []
            for row in profiles_data:
                try:
                    # Extract encrypted config from the profile data
                    encrypted_config = row.get('encrypted_config', '')
                    if not encrypted_config:
                        logger.warning(f"Profile {row.get('profile_id')} missing encrypted_config, skipping")
                        continue
                    
                    config = self._decrypt_config(encrypted_config)
                    
                    # Verify it's a Composio profile
                    if config.get('type') != 'composio':
                        continue
                    
                    profile = ComposioProfile(
                        profile_id=row.get('profile_id', ''),
                        account_id=row.get('account_id', ''),
                        mcp_qualified_name=row.get('mcp_qualified_name', ''),
                        profile_name=row.get('profile_name', ''),
                        display_name=row.get('display_name', ''),
                        encrypted_config=encrypted_config,
                        config_hash=row.get('config_hash', ''),
                        toolkit_slug=config.get('toolkit_slug', ''),
                        toolkit_name=config.get('toolkit_name', ''),
                        mcp_url=config.get('mcp_url', ''),
                        redirect_url=config.get('redirect_url'),
                        connected_account_id=config.get('connected_account_id'),
                        is_active=row.get('is_active', True),
                        is_default=row.get('is_default', False),
                        is_connected=bool(config.get('redirect_url')),
                        created_at=datetime.fromisoformat(row.get('created_at', '').replace('Z', '+00:00')) if row.get('created_at') else None,
                        updated_at=datetime.fromisoformat(row.get('updated_at', '').replace('Z', '+00:00')) if row.get('updated_at') else None
                    )
                    profiles.append(profile)
                    
                except InvalidToken:
                    logger.warning(
                        "Skipping undecryptable Composio profile %s for account %s (encryption key mismatch)",
                        row.get('profile_id'),
                        account_id,
                    )
                    continue
                except Exception as decrypt_error:
                    logger.warning(
                        "Skipping invalid Composio profile %s for account %s: %s",
                        row.get('profile_id'),
                        account_id,
                        decrypt_error,
                    )
                    continue
            
            return profiles
            
        except Exception as e:
            logger.error(f"Failed to get Composio profiles: {e}", exc_info=True)
            raise
