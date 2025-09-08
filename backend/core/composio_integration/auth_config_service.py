from typing import Optional, List, Dict, Any, Union
from composio_client import Composio
from core.utils.logger import logger
from pydantic import BaseModel

from .client import ComposioClient


class AuthConfig(BaseModel):
    id: str
    auth_scheme: str
    is_composio_managed: bool = True
    restrict_to_following_tools: List[str] = []
    toolkit_slug: str


class AuthConfigService:
    def __init__(self, api_key: Optional[str] = None):
        self.client = ComposioClient.get_client(api_key)
    
    def _convert_field_value(self, value: str, field_type: str) -> Union[str, bool, float]:
        if field_type == 'boolean':
            if isinstance(value, bool):
                return value
            return value.lower() in ('true', '1', 'yes', 'on')
        elif field_type == 'number' or field_type == 'double':
            try:
                return float(value)
            except (ValueError, TypeError):
                logger.warning(f"Failed to convert '{value}' to float, using as string")
                return str(value)
        else:
            return str(value)
    
    async def create_auth_config(
        self, 
        toolkit_slug: str, 
        initiation_fields: Optional[Dict[str, str]] = None,
        custom_auth_config: Optional[Dict[str, str]] = None,
        use_custom_auth: bool = False
    ) -> AuthConfig:
        try:
            logger.debug(f"Creating auth config for toolkit: {toolkit_slug}")
            logger.debug(f"Initiation fields: {initiation_fields}")
            logger.debug(f"Custom auth config provided: {bool(custom_auth_config)}")
            logger.debug(f"Use custom auth: {use_custom_auth}")
            
            # If custom auth config is provided, use it for credentials
            if use_custom_auth and custom_auth_config:
                logger.debug("Creating custom auth config with user-provided credentials")
                
                # Build credentials from custom auth config fields
                credentials = {}
                for field_name, field_value in custom_auth_config.items():
                    if field_value:
                        credentials[field_name] = str(field_value)
                
                logger.debug(f"Using custom credentials (keys): {list(credentials.keys())}")
                
                response = self.client.auth_configs.create(
                    toolkit={
                        "slug": toolkit_slug
                    },
                    auth_config={
                        "type": "use_custom_auth",
                        "credentials": credentials,
                        "authScheme": "OAUTH2"
                    }
                )
            else:
                # Standard Composio-managed auth
                credentials = {"region": "ind"}
                
                if initiation_fields:
                    for field_name, field_value in initiation_fields.items():
                        if field_value:
                            if field_name == "suffix.one":
                                credentials["extension"] = str(field_value)
                            else:
                                credentials[field_name] = str(field_value)
                
                logger.debug(f"Using composio-managed credentials: {credentials}")
                
                response = self.client.auth_configs.create(
                    toolkit={
                        "slug": toolkit_slug
                    },
                    auth_config={
                        "type": "use_composio_managed_auth",
                        "credentials": credentials
                    }
                )
            
            auth_config_obj = response.auth_config
            
            auth_config = AuthConfig(
                id=auth_config_obj.id,
                auth_scheme=auth_config_obj.auth_scheme,
                is_composio_managed=getattr(auth_config_obj, 'is_composio_managed', not use_custom_auth),
                restrict_to_following_tools=getattr(auth_config_obj, 'restrict_to_following_tools', []),
                toolkit_slug=toolkit_slug
            )
            
            logger.debug(f"Successfully created auth config: {auth_config.id}")
            return auth_config
            
        except Exception as e:
            logger.error(f"Failed to create auth config for {toolkit_slug}: {e}", exc_info=True)
            raise
    
    async def get_auth_config(self, auth_config_id: str) -> Optional[AuthConfig]:
        try:
            logger.debug(f"Fetching auth config: {auth_config_id}")
            
            response = self.client.auth_configs.get(auth_config_id)
            
            if not response:
                return None
            
            return AuthConfig(
                id=response.id,
                auth_scheme=response.auth_scheme,
                is_composio_managed=getattr(response, 'is_composio_managed', True),
                restrict_to_following_tools=getattr(response, 'restrict_to_following_tools', []),
                toolkit_slug=getattr(response, 'toolkit_slug', '')
            )
            
        except Exception as e:
            logger.error(f"Failed to get auth config {auth_config_id}: {e}", exc_info=True)
            raise
    
    async def list_auth_configs(self, toolkit_slug: Optional[str] = None) -> List[AuthConfig]:
        try:
            logger.debug(f"Listing auth configs for toolkit: {toolkit_slug}")
            
            if toolkit_slug:
                response = self.client.auth_configs.list(toolkit=toolkit_slug)
            else:
                response = self.client.auth_configs.list()
            
            auth_configs = []
            items = getattr(response, 'items', [])
            
            for item in items:
                auth_config = AuthConfig(
                    id=item.id,
                    auth_scheme=item.auth_scheme,
                    is_composio_managed=getattr(item, 'is_composio_managed', True),
                    restrict_to_following_tools=getattr(item, 'restrict_to_following_tools', []),
                    toolkit_slug=getattr(item, 'toolkit_slug', toolkit_slug or '')
                )
                auth_configs.append(auth_config)
            
            logger.debug(f"Successfully listed {len(auth_configs)} auth configs")
            return auth_configs
            
        except Exception as e:
            logger.error(f"Failed to list auth configs: {e}", exc_info=True)
            raise 