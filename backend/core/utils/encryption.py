"""
Simple encryption utilities for Pipedream credential profiles.
"""

import os
import base64
from cryptography.fernet import Fernet
from core.utils.logger import logger


def get_encryption_key() -> bytes:
    """Get or create encryption key for credentials."""
    key_env = os.getenv("MCP_CREDENTIAL_ENCRYPTION_KEY")
    
    if key_env:
        try:
            if isinstance(key_env, str):
                return key_env.encode('utf-8')
            else:
                return key_env
        except Exception as e:
            logger.error(f"Invalid encryption key: {e}")
    
    # Generate a new key as fallback
    logger.warning("No encryption key found, generating new key for this session")
    key = Fernet.generate_key()
    logger.debug(f"Generated new encryption key. Set this in your environment:")
    logger.debug(f"MCP_CREDENTIAL_ENCRYPTION_KEY={key.decode()}")
    return key


def encrypt_data(data: str) -> str:
    """
    Encrypt a string and return base64 encoded encrypted data.
    
    Args:
        data: String data to encrypt
        
    Returns:
        Base64 encoded encrypted string
    """
    encryption_key = get_encryption_key()
    cipher = Fernet(encryption_key)
    
    # Convert string to bytes
    data_bytes = data.encode('utf-8')
    
    # Encrypt the data
    encrypted_bytes = cipher.encrypt(data_bytes)
    
    # Return base64 encoded string
    return base64.b64encode(encrypted_bytes).decode('utf-8')


def decrypt_data(encrypted_data: str) -> str:
    """
    Decrypt base64 encoded encrypted data and return the original string.
    
    Args:
        encrypted_data: Base64 encoded encrypted string
        
    Returns:
        Decrypted string
    """
    encryption_key = get_encryption_key()
    cipher = Fernet(encryption_key)
    
    # Decode base64 to get encrypted bytes
    encrypted_bytes = base64.b64decode(encrypted_data.encode('utf-8'))
    
    # Decrypt the data
    decrypted_bytes = cipher.decrypt(encrypted_bytes)
    
    # Return as string
    return decrypted_bytes.decode('utf-8') 