import os
import json
import uuid
import hashlib
import base64
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional, Tuple

from cryptography.fernet import Fernet

from core.services.supabase import DBConnection
from core.utils.logger import logger


@dataclass(frozen=True)
class MCPCredential:
    credential_id: str
    account_id: str
    mcp_qualified_name: str
    display_name: str
    config: Dict[str, Any]
    is_active: bool
    last_used_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass(frozen=True)
class MCPRequirement:
    qualified_name: str
    display_name: str
    enabled_tools: List[str] = field(default_factory=list)
    required_config: List[str] = field(default_factory=list)
    custom_type: Optional[str] = None


@dataclass
class CredentialRequest:
    account_id: str
    mcp_qualified_name: str
    display_name: str
    config: Dict[str, Any]


class CredentialNotFoundError(Exception):
    pass


class CredentialAccessDeniedError(Exception):
    pass


class EncryptionService:
    def __init__(self):
        self._encryption_key = self._get_or_create_encryption_key()
        self._cipher = Fernet(self._encryption_key)
    
    def _get_or_create_encryption_key(self) -> bytes:
        key_env = os.getenv("MCP_CREDENTIAL_ENCRYPTION_KEY")
        
        try:
            if isinstance(key_env, str):
                return key_env.encode('utf-8')
            else:
                return key_env
                
        except Exception as e:
            logger.error(f"Invalid encryption key: {e}")
            logger.warning("Generating new encryption key for this session")
            key = Fernet.generate_key()
            logger.debug(f"Generated new encryption key. Set this in your environment:")
            logger.debug(f"MCP_CREDENTIAL_ENCRYPTION_KEY={key.decode()}")
            return key
    
    def encrypt_config(self, config: Dict[str, Any]) -> Tuple[bytes, str]:
        config_json = json.dumps(config, sort_keys=True)
        config_bytes = config_json.encode('utf-8')
        
        config_hash = hashlib.sha256(config_bytes).hexdigest()
        encrypted_config = self._cipher.encrypt(config_bytes)
        
        return encrypted_config, config_hash
    
    def decrypt_config(self, encrypted_config: bytes, expected_hash: str) -> Dict[str, Any]:
        try:
            decrypted_bytes = self._cipher.decrypt(encrypted_config)
            
            actual_hash = hashlib.sha256(decrypted_bytes).hexdigest()
            if actual_hash != expected_hash:
                raise ValueError("Credential integrity check failed")
            
            config_json = decrypted_bytes.decode('utf-8')
            return json.loads(config_json)
            
        except Exception as e:
            logger.error(f"Failed to decrypt credential: {e}")
            raise ValueError("Failed to decrypt credential")


class CredentialService:
    def __init__(self, db_connection: DBConnection):
        self._db = db_connection
        self._encryption = EncryptionService()
    
    async def store_credential(
        self,
        account_id: str,
        mcp_qualified_name: str,
        display_name: str,
        config: Dict[str, Any]
    ) -> str:
        logger.debug(f"Storing credential for {mcp_qualified_name}")
        
        credential_id = str(uuid.uuid4())
        encrypted_config, config_hash = self._encryption.encrypt_config(config)
        encoded_config = base64.b64encode(encrypted_config).decode('utf-8')
        
        client = await self._db.client
        
        existing = await client.table('user_mcp_credentials').select('credential_id')\
            .eq('account_id', account_id)\
            .eq('mcp_qualified_name', mcp_qualified_name)\
            .eq('is_active', True)\
            .execute()
        
        if existing.data:
            await client.table('user_mcp_credentials').update({
                'is_active': False,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).eq('credential_id', existing.data[0]['credential_id']).execute()
        
        result = await client.table('user_mcp_credentials').insert({
            'credential_id': credential_id,
            'account_id': account_id,
            'mcp_qualified_name': mcp_qualified_name,
            'display_name': display_name,
            'encrypted_config': encoded_config,
            'config_hash': config_hash,
            'is_active': True,
            'created_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).execute()
        
        logger.debug(f"Stored credential {credential_id} for {mcp_qualified_name}")
        return credential_id
    
    async def get_credential(
        self, 
        account_id: str, 
        mcp_qualified_name: str
    ) -> Optional[MCPCredential]:
        client = await self._db.client
        result = await client.table('user_mcp_credentials').select('*')\
            .eq('account_id', account_id)\
            .eq('mcp_qualified_name', mcp_qualified_name)\
            .eq('is_active', True)\
            .execute()
        
        if not result.data:
            return None
        
        return self._map_to_credential(result.data[0])
    
    async def get_user_credentials(self, account_id: str) -> List[MCPCredential]:
        client = await self._db.client
        result = await client.table('user_mcp_credentials').select('*')\
            .eq('account_id', account_id)\
            .eq('is_active', True)\
            .order('created_at', desc=True)\
            .execute()
        
        return [self._map_to_credential(data) for data in result.data]
    
    async def delete_credential(
        self, 
        account_id: str, 
        mcp_qualified_name: str
    ) -> bool:
        logger.debug(f"Deleting credential for {mcp_qualified_name}")
        
        client = await self._db.client
        result = await client.table('user_mcp_credentials').update({
            'is_active': False,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', account_id)\
          .eq('mcp_qualified_name', mcp_qualified_name)\
          .eq('is_active', True)\
          .execute()
        
        success = len(result.data) > 0
        if success:
            logger.debug(f"Deleted credential for {mcp_qualified_name}")
        
        return success
    
    async def get_missing_credentials(
        self, 
        account_id: str, 
        requirements: List[MCPRequirement]
    ) -> List[MCPRequirement]:
        user_credentials = await self.get_user_credentials(account_id)
        credential_names = {cred.mcp_qualified_name for cred in user_credentials}
        
        missing = []
        for req in requirements:
            if req.qualified_name not in credential_names:
                missing.append(req)
        
        return missing
    
    async def build_credential_mappings(
        self, 
        account_id: str, 
        requirements: List[MCPRequirement]
    ) -> Dict[str, str]:
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
    
    async def validate_access(self, credential: MCPCredential, account_id: str) -> None:
        if credential.account_id != account_id:
            raise CredentialAccessDeniedError("Access denied to credential")
    
    def _map_to_credential(self, data: Dict[str, Any]) -> MCPCredential:
        try:
            encrypted_config = base64.b64decode(data['encrypted_config'])
            config = self._encryption.decrypt_config(encrypted_config, data['config_hash'])
        except Exception as e:
            logger.error(f"Failed to decrypt credential {data['credential_id']}: {e}")
            config = {}
        
        return MCPCredential(
            credential_id=data['credential_id'],
            account_id=data['account_id'],
            mcp_qualified_name=data['mcp_qualified_name'],
            display_name=data['display_name'],
            config=config,
            is_active=data['is_active'],
            last_used_at=datetime.fromisoformat(data['last_used_at'].replace('Z', '+00:00')) if data.get('last_used_at') else None,
            created_at=datetime.fromisoformat(data['created_at'].replace('Z', '+00:00')) if data.get('created_at') else None,
            updated_at=datetime.fromisoformat(data['updated_at'].replace('Z', '+00:00')) if data.get('updated_at') else None
        )


def get_credential_service(db_connection: DBConnection) -> CredentialService:
    return CredentialService(db_connection) 