#!/usr/bin/env python3
"""
Utility script to generate encryption key for MCP credentials

Run this script to generate a new encryption key for the secure MCP credential system.
Set the output as your MCP_CREDENTIAL_ENCRYPTION_KEY environment variable.
"""

from cryptography.fernet import Fernet
import base64

def generate_encryption_key():
    """Generate a new Fernet encryption key"""
    key = Fernet.generate_key()
    return key.decode()

def validate_key(key_string):
    """Validate that a key string is properly formatted"""
    try:
        decoded = base64.urlsafe_b64decode(key_string.encode())
        if len(decoded) != 32:
            return False, f"Key must be 32 bytes, got {len(decoded)}"
        Fernet(key_string.encode())
        return True, "Valid key"
    except Exception as e:
        return False, str(e)

if __name__ == "__main__":
    key = generate_encryption_key()
    
    print("=" * 60)
    print("MCP CREDENTIAL ENCRYPTION KEY GENERATOR")
    print("=" * 60)
    print()
    print("Generated encryption key for MCP credentials:")
    print(f"MCP_CREDENTIAL_ENCRYPTION_KEY={key}")
    print()
    print("SETUP INSTRUCTIONS:")
    print("1. Copy the key above")
    print("2. Add it to your environment variables:")
    print(f"   export MCP_CREDENTIAL_ENCRYPTION_KEY={key}")
    print()
    print("3. Or add to your .env file:")
    print(f"   MCP_CREDENTIAL_ENCRYPTION_KEY={key}")
    print()
    print("4. Restart your backend server")
    print()
    
    # Validate the generated key
    is_valid, message = validate_key(key)
    if is_valid:
        print("✅ Key validation: PASSED")
    else:
        print(f"❌ Key validation: FAILED - {message}")
    
    print()
    print("⚠️  IMPORTANT: Keep this key secure and backed up!")
    print("   If you lose this key, all stored credentials will be unrecoverable.")
    print("=" * 60) 