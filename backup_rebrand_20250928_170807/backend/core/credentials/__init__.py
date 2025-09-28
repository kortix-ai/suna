# Credentials Module - Simplified and Clean

from .credential_service import (
    CredentialService,
    MCPCredential,
    MCPRequirement,
    CredentialRequest,
    CredentialNotFoundError,
    CredentialAccessDeniedError,
    EncryptionService,
    get_credential_service
)

from .profile_service import (
    ProfileService,
    MCPCredentialProfile,
    CredentialMapping,
    ProfileRequest,
    ProfileNotFoundError,
    ProfileAccessDeniedError,
    get_profile_service
)

from .utils import (
    validate_config_not_empty,
    validate_credential_mappings,
    get_missing_credentials_advanced,
    decode_mcp_qualified_name,
    encode_mcp_qualified_name,
    extract_config_keys,
    sanitize_display_name,
    build_custom_qualified_name,
    matches_custom_pattern
)

from . import api

__all__ = [
    # Services and factory functions
    "CredentialService", "get_credential_service",
    "ProfileService", "get_profile_service",
    "EncryptionService",
    
    # Domain objects
    "MCPCredential", "MCPCredentialProfile", "MCPRequirement",
    "CredentialRequest", "ProfileRequest", "CredentialMapping",
    
    # Exceptions
    "CredentialNotFoundError", "CredentialAccessDeniedError",
    "ProfileNotFoundError", "ProfileAccessDeniedError",
    
    # Utilities
    "validate_config_not_empty", "validate_credential_mappings",
    "get_missing_credentials_advanced", "decode_mcp_qualified_name",
    "encode_mcp_qualified_name", "extract_config_keys",
    "sanitize_display_name", "build_custom_qualified_name",
    "matches_custom_pattern",
    
    # API module
    "api"
] 