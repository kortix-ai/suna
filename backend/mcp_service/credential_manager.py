"""
Secure MCP Credential Manager

This module handles:
1. Encrypting and storing MCP credentials securely
2. Retrieving and decrypting credentials for runtime use
3. Managing credential lifecycle and validation
4. Auditing credential usage
"""

import os
import json
import hashlib
import base64
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime, timezone

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from utils.logger import logger
from services.supabase import DBConnection

db = DBConnection()

@dataclass
class MCPCredential:
    """Represents an MCP credential"""
    credential_id: str
    account_id: str
    mcp_qualified_name: str
    display_name: str
    config: Dict[str, Any]
    is_active: bool
    last_used_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass
class MCPCredentialProfile:
    """Represents a named MCP credential profile"""
    profile_id: str
    account_id: str
    mcp_qualified_name: str
    profile_name: str  # "Team A Slack", "Work GitHub", etc.
    display_name: str
    config: Dict[str, Any]
    is_active: bool
    is_default: bool
    last_used_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass
class MCPRequirement:
    """Represents an MCP requirement from a template"""
    qualified_name: str
    display_name: str
    enabled_tools: List[str]
    required_config: List[str]
    custom_type: Optional[str] = None  # 'sse' or 'http' for custom MCP servers


class CredentialManager:
    """Manages secure storage and retrieval of MCP credentials"""
    
    def __init__(self):
        self.encryption_key = self._get_or_create_encryption_key()
        self.cipher = Fernet(self.encryption_key)
    
    def _get_or_create_encryption_key(self) -> bytes:
        """Get or create encryption key for credentials"""
        key_env = os.getenv("MCP_CREDENTIAL_ENCRYPTION_KEY")
        
        try:
            if isinstance(key_env, str):
                return key_env.encode('utf-8')
            else:
                return key_env
                
        except Exception as e:
            logger.error(f"Invalid encryption key: {e}")
            # Generate a new key as fallback
            logger.warning("Generating new encryption key for this session")
            key = Fernet.generate_key()
            logger.info(f"Generated new encryption key. Set this in your environment:")
            logger.info(f"MCP_CREDENTIAL_ENCRYPTION_KEY={key.decode()}")
            return key
    
    def _encrypt_config(self, config: Dict[str, Any]) -> Tuple[bytes, str]:
        """Encrypt configuration and return encrypted data + hash"""
        config_json = json.dumps(config, sort_keys=True)
        config_bytes = config_json.encode('utf-8')
        
        # Create hash for integrity checking
        config_hash = hashlib.sha256(config_bytes).hexdigest()
        
        # Encrypt the config
        encrypted_config = self.cipher.encrypt(config_bytes)
        
        return encrypted_config, config_hash
    
    def _decrypt_config(self, encrypted_config: bytes, expected_hash: str) -> Dict[str, Any]:
        """Decrypt configuration and verify integrity"""
        try:
            decrypted_bytes = self.cipher.decrypt(encrypted_config)
            
            # Verify hash
            actual_hash = hashlib.sha256(decrypted_bytes).hexdigest()
            if actual_hash != expected_hash:
                raise ValueError("Credential integrity check failed")
            
            config_json = decrypted_bytes.decode('utf-8')
            return json.loads(config_json)
            
        except Exception as e:
            logger.error(f"Failed to decrypt credential: {e}")
            raise ValueError("Failed to decrypt credential")
    
    async def store_credential(
        self, 
        account_id: str, 
        mcp_qualified_name: str, 
        display_name: str,
        config: Dict[str, Any]
    ) -> str:
        """
        Store encrypted MCP credentials for a user
        
        Args:
            account_id: User's account ID
            mcp_qualified_name: MCP server qualified name (e.g., "exa", "@smithery-ai/github")
            display_name: Human-readable name for the MCP
            config: Configuration dictionary with API keys and settings
            
        Returns:
            credential_id: UUID of the stored credential
        """
        logger.info(f"Storing credential for {mcp_qualified_name} for user {account_id}")
        
        try:
            # Encrypt the configuration
            encrypted_config, config_hash = self._encrypt_config(config)
            
            client = await db.client
            
            # Upsert the credential (encode bytes as base64 for database storage)
            encoded_config = base64.b64encode(encrypted_config).decode('utf-8')
            logger.debug(f"Encoded config length: {len(encoded_config)}, content preview: {encoded_config[:50]}...")
            
            result = await client.table('user_mcp_credentials').upsert({
                'account_id': account_id,
                'mcp_qualified_name': mcp_qualified_name,
                'display_name': display_name,
                'encrypted_config': encoded_config,
                'config_hash': config_hash,
                'is_active': True,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }, on_conflict='account_id,mcp_qualified_name').execute()
            
            if not result.data:
                raise ValueError("Failed to store credential")
            
            credential_id = result.data[0]['credential_id']
            logger.info(f"Successfully stored credential {credential_id} for {mcp_qualified_name}")
            
            return credential_id
            
        except Exception as e:
            logger.error(f"Error storing credential for {mcp_qualified_name}: {str(e)}")
            raise
    
    async def get_credential(self, account_id: str, mcp_qualified_name: str) -> Optional[MCPCredential]:
        """
        Retrieve and decrypt MCP credentials for a user
        
        Args:
            account_id: User's account ID
            mcp_qualified_name: MCP server qualified name
            
        Returns:
            MCPCredential object or None if not found
        """
        try:
            client = await db.client
            
            result = await client.table('user_mcp_credentials').select('*')\
                .eq('account_id', account_id)\
                .eq('mcp_qualified_name', mcp_qualified_name)\
                .eq('is_active', True)\
                .execute()
            
            if not result.data:
                return None
            
            cred_data = result.data[0]
            
            # Decrypt the configuration (handle both old and new formats)
            encrypted_config = cred_data['encrypted_config']
            logger.debug(f"Retrieved config type: {type(encrypted_config)}, length: {len(encrypted_config) if encrypted_config else 0}")
            
            if isinstance(encrypted_config, str):
                # New format: base64 encoded string
                logger.debug(f"Decoding base64 string of length {len(encrypted_config)}")
                try:
                    encrypted_config_bytes = base64.b64decode(encrypted_config.encode('utf-8'))
                except Exception as e:
                    logger.error(f"Failed to decode base64 credential: {e}, string: {encrypted_config[:50]}...")
                    return None
            else:
                # Old format: raw bytes (backward compatibility)
                encrypted_config_bytes = encrypted_config
            
            config = self._decrypt_config(
                encrypted_config_bytes, 
                cred_data['config_hash']
            )
            
            # Update last used timestamp
            await client.table('user_mcp_credentials')\
                .update({'last_used_at': datetime.now(timezone.utc).isoformat()})\
                .eq('credential_id', cred_data['credential_id'])\
                .execute()
            
            return MCPCredential(
                credential_id=cred_data['credential_id'],
                account_id=cred_data['account_id'],
                mcp_qualified_name=cred_data['mcp_qualified_name'],
                display_name=cred_data['display_name'],
                config=config,
                is_active=cred_data['is_active'],
                last_used_at=cred_data.get('last_used_at'),
                created_at=cred_data.get('created_at'),
                updated_at=cred_data.get('updated_at')
            )
            
        except Exception as e:
            logger.error(f"Error retrieving credential for {mcp_qualified_name}: {str(e)}")
            return None
    
    async def get_user_credentials(self, account_id: str) -> List[MCPCredential]:
        """Get all active credentials for a user"""
        try:
            client = await db.client
            
            result = await client.table('user_mcp_credentials').select('*')\
                .eq('account_id', account_id)\
                .eq('is_active', True)\
                .order('created_at', desc=True)\
                .execute()
            
            credentials = []
            for cred_data in result.data:
                try:
                    # Decrypt the configuration (handle both old and new formats)
                    encrypted_config = cred_data['encrypted_config']
                    if isinstance(encrypted_config, str):
                        # New format: base64 encoded string
                        try:
                            encrypted_config_bytes = base64.b64decode(encrypted_config.encode('utf-8'))
                        except Exception as e:
                            logger.error(f"Failed to decode base64 credential {cred_data['credential_id']}: {e}")
                            continue
                    else:
                        # Old format: raw bytes (backward compatibility)
                        encrypted_config_bytes = encrypted_config
                    
                    config = self._decrypt_config(
                        encrypted_config_bytes, 
                        cred_data['config_hash']
                    )
                    
                    credentials.append(MCPCredential(
                        credential_id=cred_data['credential_id'],
                        account_id=cred_data['account_id'],
                        mcp_qualified_name=cred_data['mcp_qualified_name'],
                        display_name=cred_data['display_name'],
                        config=config,
                        is_active=cred_data['is_active'],
                        last_used_at=cred_data.get('last_used_at'),
                        created_at=cred_data.get('created_at'),
                        updated_at=cred_data.get('updated_at')
                    ))
                except Exception as e:
                    logger.error(f"Failed to decrypt credential {cred_data['credential_id']}: {e}")
                    continue
            
            return credentials
            
        except Exception as e:
            logger.error(f"Error retrieving user credentials: {str(e)}")
            return []
    
    async def delete_credential(self, account_id: str, mcp_qualified_name: str) -> bool:
        """Delete (deactivate) a credential"""
        try:
            client = await db.client
            
            logger.debug(f"Attempting to delete credential: account_id='{account_id}', mcp_qualified_name='{mcp_qualified_name}'")
            
            # First check if the credential exists
            check_result = await client.table('user_mcp_credentials').select('credential_id, is_active')\
                .eq('account_id', account_id)\
                .eq('mcp_qualified_name', mcp_qualified_name)\
                .execute()
            
            logger.debug(f"Found {len(check_result.data)} credentials matching the query")
            if check_result.data:
                for cred in check_result.data:
                    logger.debug(f"Found credential: {cred['credential_id']}, is_active: {cred['is_active']}")
            
            result = await client.table('user_mcp_credentials')\
                .update({'is_active': False})\
                .eq('account_id', account_id)\
                .eq('mcp_qualified_name', mcp_qualified_name)\
                .execute()
            
            logger.debug(f"Update result: {len(result.data)} rows affected")
            return len(result.data) > 0
            
        except Exception as e:
            logger.error(f"Error deleting credential for {mcp_qualified_name}: {str(e)}")
            return False
      
    async def _log_credential_usage(
        self, 
        credential_id: str, 
        instance_id: Optional[str], 
        action: str, 
        success: bool, 
        error_message: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ):
        """Log credential usage for auditing"""
        try:
            client = await db.client
            
            await client.table('credential_usage_log').insert({
                'credential_id': credential_id,
                'instance_id': instance_id,
                'action': action,
                'success': success,
                'error_message': error_message,
                'metadata': metadata or {}
            }).execute()
            
        except Exception as e:
            logger.error(f"Failed to log credential usage: {e}")
    
    async def get_missing_credentials_for_requirements(
        self, 
        account_id: str, 
        requirements: List[MCPRequirement]
    ) -> List[MCPRequirement]:
        """Get list of missing credentials for given requirements"""
        user_credentials = await self.get_user_credentials(account_id)
        user_mcp_names = {cred.mcp_qualified_name for cred in user_credentials}
        
        missing = []
        for req in requirements:
            if req.custom_type:
                custom_pattern = f"custom_{req.custom_type}_"
                found = any(
                    cred_name.startswith(custom_pattern) and 
                    req.display_name.lower().replace(' ', '_') in cred_name
                    for cred_name in user_mcp_names
                )
                if not found:
                    missing.append(req)
            else:
                if req.qualified_name not in user_mcp_names:
                    missing.append(req)
        
        return missing
    
    async def build_credential_mappings(
        self, 
        account_id: str, 
        requirements: List[MCPRequirement]
    ) -> Dict[str, str]:
        """Build credential mappings for agent instance"""
        mappings = {}
        
        for req in requirements:
            if req.custom_type:
                user_credentials = await self.get_user_credentials(account_id)
                custom_pattern = f"custom_{req.custom_type}_"
                
                for cred in user_credentials:
                    if (cred.mcp_qualified_name.startswith(custom_pattern) and 
                        req.display_name.lower().replace(' ', '_') in cred.mcp_qualified_name):
                        mappings[req.qualified_name] = cred.credential_id
                        break
            else:
                credential = await self.get_credential(account_id, req.qualified_name)
                if credential:
                    mappings[req.qualified_name] = credential.credential_id
        
        return mappings

    async def store_credential_profile(
        self, 
        account_id: str, 
        mcp_qualified_name: str,
        profile_name: str,
        display_name: str,
        config: Dict[str, Any],
        is_default: bool = False
    ) -> str:
        """
        Store a named credential profile for an MCP server
        
        Args:
            account_id: User's account ID
            mcp_qualified_name: MCP server qualified name
            profile_name: Name for this profile (e.g., "Team A Slack")
            display_name: Human-readable display name
            config: Configuration dictionary with API keys and settings
            is_default: Whether this should be the default profile for this MCP server
            
        Returns:
            profile_id: UUID of the stored credential profile
        """
        logger.info(f"Storing credential profile '{profile_name}' for {mcp_qualified_name} for user {account_id}")
        
        try:
            encrypted_config, config_hash = self._encrypt_config(config)
            
            client = await db.client
            encoded_config = base64.b64encode(encrypted_config).decode('utf-8')
            if not is_default:
                existing_profiles = await self.get_credential_profiles(account_id, mcp_qualified_name)
                if not existing_profiles:
                    is_default = True
            
            result = await client.table('user_mcp_credential_profiles').upsert({
                'account_id': account_id,
                'mcp_qualified_name': mcp_qualified_name,
                'profile_name': profile_name,
                'display_name': display_name,
                'encrypted_config': encoded_config,
                'config_hash': config_hash,
                'is_active': True,
                'is_default': is_default,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }, on_conflict='account_id,mcp_qualified_name,profile_name').execute()
            
            if not result.data:
                raise ValueError("Failed to store credential profile")
            
            profile_id = result.data[0]['profile_id']
            logger.info(f"Successfully stored credential profile {profile_id} for {mcp_qualified_name}")
            
            return profile_id
            
        except Exception as e:
            logger.error(f"Error storing credential profile for {mcp_qualified_name}: {str(e)}")
            raise

    async def get_credential_profiles(
        self, 
        account_id: str, 
        mcp_qualified_name: str
    ) -> List[MCPCredentialProfile]:
        """
        Get all credential profiles for a specific MCP server
        
        Args:
            account_id: User's account ID
            mcp_qualified_name: MCP server qualified name
            
        Returns:
            List of MCPCredentialProfile objects
        """
        try:
            client = await db.client
            
            result = await client.table('user_mcp_credential_profiles').select('*')\
                .eq('account_id', account_id)\
                .eq('mcp_qualified_name', mcp_qualified_name)\
                .eq('is_active', True)\
                .order('is_default', desc=True)\
                .order('created_at', desc=False)\
                .execute()
            
            profiles = []
            for profile_data in result.data:
                try:
                    # Decrypt the configuration
                    encrypted_config = profile_data['encrypted_config']
                    if isinstance(encrypted_config, str):
                        encrypted_config_bytes = base64.b64decode(encrypted_config.encode('utf-8'))
                    else:
                        encrypted_config_bytes = encrypted_config
                    
                    config = self._decrypt_config(
                        encrypted_config_bytes, 
                        profile_data['config_hash']
                    )
                    
                    profiles.append(MCPCredentialProfile(
                        profile_id=profile_data['profile_id'],
                        account_id=profile_data['account_id'],
                        mcp_qualified_name=profile_data['mcp_qualified_name'],
                        profile_name=profile_data['profile_name'],
                        display_name=profile_data['display_name'],
                        config=config,
                        is_active=profile_data['is_active'],
                        is_default=profile_data['is_default'],
                        last_used_at=profile_data.get('last_used_at'),
                        created_at=profile_data.get('created_at'),
                        updated_at=profile_data.get('updated_at')
                    ))
                except Exception as e:
                    logger.error(f"Failed to decrypt credential profile {profile_data['profile_id']}: {e}")
                    continue
            
            return profiles
            
        except Exception as e:
            logger.error(f"Error retrieving credential profiles for {mcp_qualified_name}: {str(e)}")
            return []

    async def get_credential_by_profile(
        self, 
        account_id: str, 
        profile_id: str
    ) -> Optional[MCPCredentialProfile]:
        """
        Get a specific credential profile by its ID
        
        Args:
            account_id: User's account ID (for security)
            profile_id: Profile ID
            
        Returns:
            MCPCredentialProfile object or None if not found
        """
        try:
            client = await db.client
            
            result = await client.table('user_mcp_credential_profiles').select('*')\
                .eq('account_id', account_id)\
                .eq('profile_id', profile_id)\
                .eq('is_active', True)\
                .execute()
            
            if not result.data:
                return None
            
            profile_data = result.data[0]
            
            # Decrypt the configuration
            encrypted_config = profile_data['encrypted_config']
            if isinstance(encrypted_config, str):
                encrypted_config_bytes = base64.b64decode(encrypted_config.encode('utf-8'))
            else:
                encrypted_config_bytes = encrypted_config
            
            config = self._decrypt_config(
                encrypted_config_bytes, 
                profile_data['config_hash']
            )
            
            # Update last used timestamp
            await client.table('user_mcp_credential_profiles')\
                .update({'last_used_at': datetime.now(timezone.utc).isoformat()})\
                .eq('profile_id', profile_id)\
                .execute()
            
            return MCPCredentialProfile(
                profile_id=profile_data['profile_id'],
                account_id=profile_data['account_id'],
                mcp_qualified_name=profile_data['mcp_qualified_name'],
                profile_name=profile_data['profile_name'],
                display_name=profile_data['display_name'],
                config=config,
                is_active=profile_data['is_active'],
                is_default=profile_data['is_default'],
                last_used_at=profile_data.get('last_used_at'),
                created_at=profile_data.get('created_at'),
                updated_at=profile_data.get('updated_at')
            )
            
        except Exception as e:
            logger.error(f"Error retrieving credential profile {profile_id}: {str(e)}")
            return None

    async def get_default_credential_profile(
        self, 
        account_id: str, 
        mcp_qualified_name: str
    ) -> Optional[MCPCredentialProfile]:
        """
        Get the default credential profile for an MCP server
        
        Args:
            account_id: User's account ID
            mcp_qualified_name: MCP server qualified name
            
        Returns:
            Default MCPCredentialProfile or first available profile
        """
        profiles = await self.get_credential_profiles(account_id, mcp_qualified_name)
        
        for profile in profiles:
            if profile.is_default:
                return profile
        
        return profiles[0] if profiles else None

    async def set_default_profile(
        self, 
        account_id: str, 
        profile_id: str
    ) -> bool:
        """
        Set a profile as the default for its MCP server
        
        Args:
            account_id: User's account ID (for security)
            profile_id: Profile ID to set as default
            
        Returns:
            True if successful, False otherwise
        """
        try:
            client = await db.client
            
            profile = await self.get_credential_by_profile(account_id, profile_id)
            if not profile:
                return False
            
            result = await client.table('user_mcp_credential_profiles')\
                .update({'is_default': True})\
                .eq('profile_id', profile_id)\
                .eq('account_id', account_id)\
                .execute()
            
            return len(result.data) > 0
            
        except Exception as e:
            logger.error(f"Error setting default profile {profile_id}: {str(e)}")
            return False

    async def delete_credential_profile(
        self, 
        account_id: str, 
        profile_id: str
    ) -> bool:
        """
        Delete (deactivate) a credential profile
        
        Args:
            account_id: User's account ID (for security)
            profile_id: Profile ID to delete
            
        Returns:
            True if successful, False otherwise
        """
        try:
            client = await db.client
            profile = await self.get_credential_by_profile(account_id, profile_id)
            if not profile:
                return False
            if profile.is_default:
                other_profiles = await self.get_credential_profiles(account_id, profile.mcp_qualified_name)
                other_active_profiles = [p for p in other_profiles if p.profile_id != profile_id]
                
                if other_active_profiles:
                    await self.set_default_profile(account_id, other_active_profiles[0].profile_id)
            
            result = await client.table('user_mcp_credential_profiles')\
                .update({'is_active': False})\
                .eq('profile_id', profile_id)\
                .eq('account_id', account_id)\
                .execute()
            
            return len(result.data) > 0
            
        except Exception as e:
            logger.error(f"Error deleting credential profile {profile_id}: {str(e)}")
            return False

    async def get_all_user_credential_profiles(self, account_id: str) -> List[MCPCredentialProfile]:
        """Get all credential profiles for a user across all MCP servers"""
        try:
            client = await db.client
            
            result = await client.table('user_mcp_credential_profiles').select('*')\
                .eq('account_id', account_id)\
                .eq('is_active', True)\
                .order('mcp_qualified_name')\
                .order('is_default', desc=True)\
                .order('created_at', desc=False)\
                .execute()
            
            profiles = []
            for profile_data in result.data:
                try:
                    encrypted_config = profile_data['encrypted_config']
                    if isinstance(encrypted_config, str):
                        encrypted_config_bytes = base64.b64decode(encrypted_config.encode('utf-8'))
                    else:
                        encrypted_config_bytes = encrypted_config
                    
                    config = self._decrypt_config(
                        encrypted_config_bytes, 
                        profile_data['config_hash']
                    )
                    
                    profiles.append(MCPCredentialProfile(
                        profile_id=profile_data['profile_id'],
                        account_id=profile_data['account_id'],
                        mcp_qualified_name=profile_data['mcp_qualified_name'],
                        profile_name=profile_data['profile_name'],
                        display_name=profile_data['display_name'],
                        config=config,
                        is_active=profile_data['is_active'],
                        is_default=profile_data['is_default'],
                        last_used_at=profile_data.get('last_used_at'),
                        created_at=profile_data.get('created_at'),
                        updated_at=profile_data.get('updated_at')
                    ))
                except Exception as e:
                    logger.error(f"Failed to decrypt credential profile {profile_data['profile_id']}: {e}")
                    continue
            
            return profiles
            
        except Exception as e:
            logger.error(f"Error retrieving all user credential profiles: {str(e)}")
            return []


credential_manager = CredentialManager() 