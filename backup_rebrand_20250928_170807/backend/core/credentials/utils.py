from typing import List, Dict, Any
from urllib.parse import unquote

from .credential_service import MCPRequirement, MCPCredential


def validate_config_not_empty(config: Dict[str, Any]) -> Dict[str, Any]:
    if not config:
        raise ValueError('Config cannot be empty')
    return config


def validate_credential_mappings(
    mappings: Dict[str, str], 
    requirements: List[MCPRequirement]
) -> List[str]:
    missing_mappings = []
    
    for req in requirements:
        if req.qualified_name not in mappings:
            missing_mappings.append(req.qualified_name)
    
    return missing_mappings


def get_missing_credentials_advanced(
    user_credentials: List[MCPCredential], 
    requirements: List[MCPRequirement]
) -> List[MCPRequirement]:
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


def decode_mcp_qualified_name(encoded_name: str) -> str:
    return unquote(encoded_name)


def encode_mcp_qualified_name(qualified_name: str) -> str:
    from urllib.parse import quote
    return quote(qualified_name, safe='')


def extract_config_keys(config: Dict[str, Any]) -> List[str]:
    return list(config.keys()) if config else []


def sanitize_display_name(display_name: str) -> str:
    return display_name.lower().replace(' ', '_').replace('-', '_')


def build_custom_qualified_name(custom_type: str, display_name: str) -> str:
    sanitized_name = sanitize_display_name(display_name)
    return f"custom_{custom_type}_{sanitized_name}"


def matches_custom_pattern(qualified_name: str, pattern: str, display_name: str) -> bool:
    if not qualified_name.startswith(pattern):
        return False
    
    sanitized_display = sanitize_display_name(display_name)
    return sanitized_display in qualified_name 